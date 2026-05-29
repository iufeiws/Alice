from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import sentencepiece as spm

from ort_cpu_runtime import EXECUTION_PROVIDER_CPU, OrtCpuRuntime, _normalize_sample_mode


SENTENCE_END_PUNCTUATION = set(".!?。！？")
CLAUSE_SPLIT_PUNCTUATION = set(",;:，；：、")
CLOSING_PUNCTUATION = set("\"'”’）】》」』")


class MossOnnxRuntime(OrtCpuRuntime):
    def __init__(
        self,
        model_dir: str | Path,
        *,
        output_dir: str | Path,
        thread_count: int,
        max_new_frames: int | None,
        sample_mode: str | None,
    ) -> None:
        super().__init__(
            model_dir=model_dir,
            thread_count=thread_count,
            max_new_frames=max_new_frames,
            sample_mode=sample_mode,
            execution_provider=EXECUTION_PROVIDER_CPU,
        )
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        tokenizer_path = self.resolve_manifest_relative_path(
            str(self.manifest["model_files"].get("tokenizer_model", "tokenizer.model"))
        )
        self.sp_model = spm.SentencePieceProcessor(model_file=str(tokenizer_path))

    def encode_text(self, text: str) -> list[int]:
        return [int(token_id) for token_id in self.sp_model.encode(str(text or ""), out_type=int)]

    def count_text_tokens(self, text: str) -> int:
        return len(self.encode_text(text))

    def synthesize(
        self,
        *,
        text: str,
        reference_audio_path: str | Path,
        output_audio_path: str | Path,
        seed: int | None,
        voice_clone_max_text_tokens: int,
    ) -> dict[str, Any]:
        if seed is not None:
            self.rng = np.random.default_rng(int(seed))
        prepared_text = prepare_text(text)
        prompt_audio_codes = self.encode_reference_audio(reference_audio_path)
        chunks = self.split_text(prepared_text, max_tokens=voice_clone_max_text_tokens)
        sample_rate = int(self.codec_meta["codec_config"]["sample_rate"])
        channels = int(self.codec_meta["codec_config"]["channels"])
        waveforms: list[np.ndarray] = []
        all_frames: list[list[int]] = []
        for index, chunk in enumerate(chunks):
            token_ids = self.encode_text(chunk)
            rows = self.build_voice_clone_request_rows(prompt_audio_codes, token_ids)
            generated_frames = self.generate_audio_frames(rows)
            all_frames.extend(generated_frames)
            waveforms.append(self.decode_full_audio_safe(generated_frames))
            if index < len(chunks) - 1:
                pause_samples = int(round(sample_rate * inter_chunk_pause_seconds(chunk)))
                if pause_samples > 0:
                    waveforms.append(np.zeros((pause_samples, channels), dtype=np.float32))
        waveform = concat_waveforms(waveforms)
        output_path = write_waveform_to_wav(output_audio_path, waveform, sample_rate)
        duration = float(waveform.shape[0]) / float(sample_rate) if sample_rate > 0 else 0.0
        return {
            "audioPath": str(output_path),
            "sampleRate": sample_rate,
            "channels": channels,
            "durationSeconds": duration,
            "textChunks": chunks,
            "generatedFrameCount": len(all_frames),
        }

    def encode_reference_audio(self, reference_audio_path: str | Path) -> list[list[int]]:
        waveform_array = load_reference_wav(
            reference_audio_path,
            target_sample_rate=int(self.codec_meta["codec_config"]["sample_rate"]),
            target_channels=int(self.codec_meta["codec_config"]["channels"]),
        )
        waveform_length = int(waveform_array.shape[-1])
        outputs = self.sessions["codec_encode"].run(
            None,
            {
                "waveform": waveform_array,
                "input_lengths": np.asarray([waveform_length], dtype=np.int32),
            },
        )
        output_names = [output.name for output in self.sessions["codec_encode"].get_outputs()]
        named_outputs = dict(zip(output_names, outputs, strict=True))
        audio_codes = np.asarray(named_outputs["audio_codes"], dtype=np.int32)
        audio_code_lengths = np.asarray(named_outputs["audio_code_lengths"], dtype=np.int32)
        code_length = int(audio_code_lengths.reshape(-1)[0])
        num_quantizers = int(self.codec_meta["codec_config"]["num_quantizers"])
        return [
            [int(audio_codes[0, frame_index, quantizer_index]) for quantizer_index in range(num_quantizers)]
            for frame_index in range(code_length)
        ]

    def decode_full_audio_safe(self, generated_frames: list[list[int]]) -> np.ndarray:
        channel_arrays, _audio_length = self.decode_full_audio(generated_frames)
        return merge_audio_channels(channel_arrays)

    def split_text(self, text: str, *, max_tokens: int) -> list[str]:
        normalized = str(text or "").strip()
        if not normalized:
            return []
        safe_max_tokens = max(1, int(max_tokens))
        sentence_candidates = split_by_punctuation(normalized, SENTENCE_END_PUNCTUATION) or [normalized]
        chunks: list[str] = []
        current = ""
        for sentence in sentence_candidates:
            pieces = [sentence]
            if self.count_text_tokens(sentence) > safe_max_tokens:
                clauses = split_by_punctuation(sentence, CLAUSE_SPLIT_PUNCTUATION) or [sentence]
                pieces = []
                for clause in clauses:
                    pieces.extend(self.split_text_by_token_budget(clause, safe_max_tokens))
            for piece in pieces:
                if not current:
                    current = piece
                    continue
                candidate = join_sentence_parts(current, piece)
                if self.count_text_tokens(candidate) > safe_max_tokens:
                    chunks.append(current.strip())
                    current = piece
                else:
                    current = candidate
        if current:
            chunks.append(current.strip())
        return chunks or [normalized]

    def split_text_by_token_budget(self, text: str, max_tokens: int) -> list[str]:
        remaining = str(text or "").strip()
        if not remaining:
            return []
        pieces: list[str] = []
        while remaining:
            if self.count_text_tokens(remaining) <= max_tokens:
                pieces.append(remaining)
                break
            low, high, best = 1, len(remaining), 1
            while low <= high:
                mid = (low + high) // 2
                candidate = remaining[:mid].strip()
                if candidate and self.count_text_tokens(candidate) <= max_tokens:
                    best = mid
                    low = mid + 1
                else:
                    high = mid - 1
            cut = best
            for scan in range(len(remaining[:best]) - 1, max(-1, best - 25), -1):
                if remaining[scan] in SENTENCE_END_PUNCTUATION or remaining[scan] in CLAUSE_SPLIT_PUNCTUATION or remaining[scan].isspace():
                    cut = scan + 1
                    break
            piece = remaining[:cut].strip() or remaining[:best].strip()
            pieces.append(piece)
            remaining = remaining[cut:].strip()
        return pieces


def load_reference_wav(path_value: str | Path, *, target_sample_rate: int, target_channels: int) -> np.ndarray:
    audio_path = Path(path_value).expanduser().resolve()
    with wave.open(str(audio_path), "rb") as wav_file:
        channels = int(wav_file.getnchannels())
        sample_width = int(wav_file.getsampwidth())
        sample_rate = int(wav_file.getframerate())
        frames = int(wav_file.getnframes())
        raw = wav_file.readframes(frames)
    if sample_width != 2:
        raise ValueError("reference audio must be 16-bit PCM wav")
    if sample_rate != target_sample_rate:
        raise ValueError(f"reference audio sample rate must be {target_sample_rate} Hz, got {sample_rate}")
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels <= 0:
        raise ValueError("reference audio has no channels")
    waveform = pcm.reshape(-1, channels).T
    if channels == target_channels:
        pass
    elif channels == 1 and target_channels > 1:
        waveform = np.repeat(waveform, target_channels, axis=0)
    elif channels > 1 and target_channels == 1:
        waveform = waveform.mean(axis=0, keepdims=True)
    else:
        raise ValueError(f"unsupported reference audio channel conversion: {channels} -> {target_channels}")
    return waveform.reshape(1, target_channels, -1).astype(np.float32, copy=False)


def prepare_text(text: str) -> str:
    normalized = str(text or "").strip().replace("\r", " ").replace("\n", " ")
    while "  " in normalized:
        normalized = normalized.replace("  ", " ")
    if not normalized:
        raise ValueError("text cannot be empty")
    if contains_cjk(normalized):
        if normalized[-1] not in SENTENCE_END_PUNCTUATION:
            normalized += "。"
        return normalized
    if normalized[:1].islower():
        normalized = normalized[:1].upper() + normalized[1:]
    if normalized[-1].isalnum():
        normalized += "."
    if len([item for item in normalized.split() if item]) < 5:
        normalized = f"        {normalized}"
    return normalized


def contains_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf" or "\u3040" <= ch <= "\u30ff" or "\uac00" <= ch <= "\ud7af" for ch in text)


def split_by_punctuation(text: str, punctuation: set[str]) -> list[str]:
    sentences: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        current.append(character)
        if character in punctuation:
            lookahead = index + 1
            while lookahead < len(text) and text[lookahead] in CLOSING_PUNCTUATION:
                current.append(text[lookahead])
                lookahead += 1
            sentence = "".join(current).strip()
            if sentence:
                sentences.append(sentence)
            current.clear()
            while lookahead < len(text) and text[lookahead].isspace():
                lookahead += 1
            index = lookahead
            continue
        index += 1
    tail = "".join(current).strip()
    if tail:
        sentences.append(tail)
    return sentences


def join_sentence_parts(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    if contains_cjk(left) or contains_cjk(right):
        return left + right
    return f"{left} {right}"


def inter_chunk_pause_seconds(text: str) -> float:
    return 0.35 if len([item for item in str(text or "").split() if item]) <= 4 else 0.60


def merge_audio_channels(channel_arrays: list[np.ndarray]) -> np.ndarray:
    if not channel_arrays:
        return np.zeros((0, 1), dtype=np.float32)
    if len(channel_arrays) == 1:
        return np.asarray(channel_arrays[0], dtype=np.float32).reshape(-1, 1)
    min_length = min(int(channel.shape[0]) for channel in channel_arrays)
    return np.stack([np.asarray(channel[:min_length], dtype=np.float32) for channel in channel_arrays], axis=1)


def concat_waveforms(waveforms: list[np.ndarray]) -> np.ndarray:
    non_empty = [waveform for waveform in waveforms if waveform.size > 0]
    if not non_empty:
        return np.zeros((0, 1), dtype=np.float32)
    return np.concatenate(non_empty, axis=0)


def write_waveform_to_wav(path_value: str | Path, waveform: np.ndarray, sample_rate: int) -> Path:
    output_path = Path(path_value).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.asarray(waveform, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio.reshape(-1, 1)
    clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = np.round(clipped * 32767.0).astype("<i2")
    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(int(pcm16.shape[1]))
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate))
        wav_file.writeframes(pcm16.tobytes())
    return output_path


class MossHandler(BaseHTTPRequestHandler):
    runtime: MossOnnxRuntime
    shutdown_event: threading.Event

    def do_GET(self) -> None:
        if self.path == "/health":
            self.write_json(200, {"ok": True, "ready": True})
            return
        self.write_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/shutdown":
            self.write_json(200, {"ok": True})
            self.shutdown_event.set()
            return
        if self.path != "/synthesize":
            self.write_json(404, {"ok": False, "error": "not found"})
            return
        try:
            body = self.read_json_body()
            text = required_string(body, "text")
            reference_audio_path = required_string(body, "referenceAudioPath")
            output_path = required_string(body, "outputPath")
            seed = body.get("seed")
            max_tokens = int(body.get("voiceCloneMaxTextTokens") or 75)
            started_at = time.perf_counter()
            result = self.runtime.synthesize(
                text=text,
                reference_audio_path=reference_audio_path,
                output_audio_path=output_path,
                seed=int(seed) if seed is not None else None,
                voice_clone_max_text_tokens=max_tokens,
            )
            result["elapsedSeconds"] = time.perf_counter() - started_at
            self.write_json(200, {"ok": True, **result})
        except Exception as error:
            logging.exception("synthesize failed")
            self.write_json(500, {"ok": False, "error": str(error)})

    def log_message(self, format_value: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), format_value % args)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def write_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def required_string(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lightweight MOSS-TTS-Nano ONNX HTTP service")
    parser.add_argument("--host", default=os.environ.get("MOSS_TTS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MOSS_TTS_PORT", "8765")))
    parser.add_argument("--model-dir", default=os.environ.get("MOSS_TTS_MODEL_DIR", "assets/tts/moss-onnx/models"))
    parser.add_argument("--output-dir", default=os.environ.get("MOSS_TTS_OUTPUT_DIR", "assets/generated/tts"))
    parser.add_argument("--threads", type=int, default=int(os.environ.get("MOSS_TTS_THREADS", "4")))
    parser.add_argument("--max-new-frames", type=int, default=int(os.environ.get("MOSS_TTS_MAX_NEW_FRAMES", "0")))
    parser.add_argument("--sample-mode", default=os.environ.get("MOSS_TTS_SAMPLE_MODE", "fixed"))
    parser.add_argument("--warmup", action="store_true")
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[moss-tts] %(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    max_new_frames = args.max_new_frames if args.max_new_frames > 0 else None
    runtime = MossOnnxRuntime(
        model_dir=args.model_dir,
        output_dir=args.output_dir,
        thread_count=args.threads,
        max_new_frames=max_new_frames,
        sample_mode=_normalize_sample_mode(args.sample_mode),
    )
    if args.warmup:
        runtime.warmup()
    shutdown_event = threading.Event()

    def handler_factory(*handler_args: Any, **handler_kwargs: Any) -> MossHandler:
        handler = MossHandler(*handler_args, **handler_kwargs)
        return handler

    MossHandler.runtime = runtime
    MossHandler.shutdown_event = shutdown_event
    server = ThreadingHTTPServer((args.host, args.port), handler_factory)

    def request_shutdown(_signum: int, _frame: Any) -> None:
        shutdown_event.set()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    logging.info("ready host=%s port=%s model_dir=%s", args.host, args.port, Path(args.model_dir).resolve())
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    shutdown_event.wait()
    server.shutdown()
    server.server_close()
    logging.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
