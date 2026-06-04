from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import logging
import os
import signal
import threading
import time
import unicodedata
import gc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

os.environ.setdefault("GENIE_DATA_DIR", "assets/tts/genie/GenieData")

import genie_tts as genie
import numpy as np
import soundfile as sf

GENIE_TTS_PART_SILENCE_SECONDS = 2 / 3

_memory_peak_lock = threading.Lock()
_memory_peak_label = "startup"
_memory_peak_rss_mb = 0.0
_memory_peak_running = True


def env_flag_enabled(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def release_unused_memory() -> None:
    gc.collect()
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except Exception:
        return


def release_genie_auxiliary_models(*, cn_hubert: bool = False, speaker_verification: bool = False) -> None:
    try:
        from genie_tts.ModelManager import model_manager
    except Exception:
        return
    if cn_hubert:
        model_manager.cn_hubert = None
    if speaker_verification:
        model_manager.speaker_verification_model = None
    release_unused_memory()


def current_rss_mb() -> float | None:
    try:
        status = Path("/proc/self/status").read_text(encoding="utf-8")
    except Exception:
        return None
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) / 1024
    return None


def log_memory(label: str) -> None:
    rss = current_rss_mb()
    if rss is not None:
        logging.info("memory %s rss=%.1fMB", label, rss)


def start_memory_peak_sampler(interval_seconds: float = 0.05) -> threading.Thread:
    def sample() -> None:
        global _memory_peak_rss_mb
        while _memory_peak_running:
            rss = current_rss_mb()
            if rss is not None:
                with _memory_peak_lock:
                    if rss > _memory_peak_rss_mb:
                        _memory_peak_rss_mb = rss
            time.sleep(interval_seconds)

    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    return thread


def reset_memory_peak(label: str) -> None:
    global _memory_peak_label, _memory_peak_rss_mb
    with _memory_peak_lock:
        _memory_peak_label = label
        _memory_peak_rss_mb = current_rss_mb() or 0.0


def log_memory_peak(label: str) -> None:
    with _memory_peak_lock:
        logging.info("memory_peak %s max_rss=%.1fMB", label, _memory_peak_rss_mb)


def disable_genie_audio_playback() -> None:
    try:
        from genie_tts.Core.TTSPlayer import tts_player
    except Exception:
        return

    def skip_playback_worker_loop() -> None:
        tts_player._playback_done_event.set()

    tts_player._playback_worker_loop = skip_playback_worker_loop


disable_genie_audio_playback()


def install_memory_lean_genie_loader() -> None:
    try:
        import onnx
        import onnxruntime
        import genie_tts.ModelManager as genie_model_manager
    except Exception:
        return

    def load_session_with_streaming_fp16_conversion(
        onnx_path: str,
        fp16_bin_path: str,
        providers: list[str],
        sess_options: object | None = None,
    ) -> object:
        if not os.path.exists(onnx_path):
            raise FileNotFoundError(f"ONNX Model not found: {onnx_path}")
        if not os.path.exists(fp16_bin_path):
            raise FileNotFoundError(f"FP16 Weight file not found: {fp16_bin_path}")

        model_proto = onnx.load(onnx_path, load_external_data=False)
        fp16_data = np.memmap(fp16_bin_path, dtype=np.float16, mode="r")

        for tensor in model_proto.graph.initializer:
            if tensor.data_location != onnx.TensorProto.EXTERNAL:
                continue

            offset = 0
            length = 0
            for entry in tensor.external_data:
                if entry.key == "offset":
                    offset = int(entry.value)
                elif entry.key == "length":
                    length = int(entry.value)

            element_start = offset // 4
            element_count = length // 4
            if offset % 4 != 0 or length % 4 != 0 or element_start + element_count > len(fp16_data):
                raise ValueError(
                    f"Invalid FP16 external data range for tensor {tensor.name}: "
                    f"offset={offset} length={length} fp16_elements={len(fp16_data)}"
                )

            tensor.raw_data = fp16_data[element_start:element_start + element_count].astype(np.float32).tobytes()
            del tensor.external_data[:]
            tensor.data_location = onnx.TensorProto.DEFAULT

        try:
            return onnxruntime.InferenceSession(
                model_proto.SerializeToString(),
                providers=providers,
                sess_options=sess_options,
            )
        finally:
            del model_proto
            del fp16_data
            release_unused_memory()

    genie_model_manager.load_session_with_fp16_conversion = load_session_with_streaming_fp16_conversion


install_memory_lean_genie_loader()


def install_roberta_policy() -> None:
    if env_flag_enabled("GENIE_TTS_ENABLE_ROBERTA", False):
        return
    try:
        from genie_tts.ModelManager import model_manager
    except Exception:
        return

    def skip_roberta_model(*_args: object, **_kwargs: object) -> bool:
        model_manager.roberta_model = None
        model_manager.roberta_tokenizer = None
        return False

    model_manager.load_roberta_model = skip_roberta_model
    model_manager.roberta_model = None
    model_manager.roberta_tokenizer = None


install_roberta_policy()


def ssl_cache_path(audio_path: str | Path) -> Path:
    path = Path(audio_path).expanduser().resolve()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    cache_dir = Path(os.environ.get("GENIE_TTS_SSL_CACHE_DIR", "assets/tts/genie/ssl-cache")).expanduser().resolve()
    return cache_dir / f"{digest}.ssl.npy"


def install_reference_ssl_cache() -> None:
    try:
        import genie_tts.Audio.ReferenceAudio as reference_audio_module
    except Exception:
        return

    reference_audio_class = reference_audio_module.ReferenceAudio
    if getattr(reference_audio_class, "_alice_ssl_cache_installed", False):
        return

    def cached_init(self: object, prompt_wav: str, prompt_text: str, language: str) -> None:
        if hasattr(self, "_initialized"):
            return

        self.text = prompt_text
        self.phonemes_seq = None
        self.text_bert = None
        self.set_text(prompt_text, language=language)

        self.audio_32k = reference_audio_module.load_audio(
            audio_path=prompt_wav,
            target_sampling_rate=32000,
        )
        self.audio_16k = reference_audio_module.soxr.resample(self.audio_32k, 32000, 16000, quality="hq")

        self.audio_32k = np.expand_dims(self.audio_32k, axis=0)
        self.audio_16k = np.expand_dims(self.audio_16k, axis=0)

        cache_path = ssl_cache_path(prompt_wav)
        if cache_path.is_file():
            self.ssl_content = np.load(cache_path, allow_pickle=False)
            logging.info("genie reference ssl cache hit: %s", cache_path)
        else:
            logging.info("genie reference ssl cache miss: %s", cache_path)
            if not reference_audio_module.model_manager.cn_hubert:
                reference_audio_module.model_manager.load_cn_hubert()
            self.ssl_content = reference_audio_module.model_manager.cn_hubert.run(
                None,
                {"input_values": self.audio_16k},
            )[0]
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = cache_path.with_suffix(".tmp.npy")
            np.save(temp_path, self.ssl_content)
            os.replace(temp_path, cache_path)

        self.global_emb = None
        self.global_emb_advanced = None
        self._initialized = True

    reference_audio_class.__init__ = cached_init
    reference_audio_class._alice_ssl_cache_installed = True


install_reference_ssl_cache()


class GenieRuntime:
    def __init__(
        self,
        *,
        character_name: str,
        model_dir: str | Path,
        language: str,
        reference_audio: str | Path,
        reference_text: str | Path,
    ) -> None:
        self.character_name = character_name
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.language = language
        self.reference_audio = Path(reference_audio).expanduser().resolve()
        self.reference_text = Path(reference_text).expanduser().resolve()
        self._loaded_model_key: tuple[str, str] | None = None
        self._reference_key: tuple[str, str, str] | None = None
        self._lock = threading.Lock()

    def _load(self, *, model_dir: Path, language: str, reference_audio: Path, reference_text: str) -> None:
        if not model_dir.is_dir():
            raise FileNotFoundError(f"Genie model directory was not found: {model_dir}")
        if not reference_audio.is_file():
            raise FileNotFoundError(f"Genie reference audio was not found: {reference_audio}")
        audio_text = reference_text.strip()
        if not audio_text:
            raise ValueError("Genie reference text is empty")
        model_key = (str(model_dir), language)
        if self._loaded_model_key != model_key:
            self._unload_current_character()
            log_memory(f"before_load_character model={model_dir.name} language={language}")
            reset_memory_peak(f"load_character model={model_dir.name} language={language}")
            genie.load_character(
                character_name=self.character_name,
                onnx_model_dir=str(model_dir),
                language=language,
            )
            log_memory_peak(f"load_character model={model_dir.name} language={language}")
            release_unused_memory()
            log_memory(f"after_load_character model={model_dir.name} language={language}")
            self._loaded_model_key = model_key
            self._reference_key = None

        reference_key = (str(reference_audio), audio_text, language)
        if self._reference_key != reference_key:
            log_memory(f"before_set_reference_audio language={language}")
            reset_memory_peak(f"set_reference_audio language={language}")
            genie.set_reference_audio(
                character_name=self.character_name,
                audio_path=str(reference_audio),
                audio_text=audio_text,
                language=language,
            )
            log_memory_peak(f"set_reference_audio language={language}")
            release_genie_auxiliary_models(cn_hubert=True)
            log_memory(f"after_set_reference_audio language={language}")
            self._reference_key = reference_key

    def _unload_current_character(self) -> None:
        if self._loaded_model_key is None:
            return
        unload_character = getattr(genie, "unload_character", None)
        if callable(unload_character):
            try:
                unload_character(character_name=self.character_name)
            except Exception:
                logging.warning("failed to unload previous Genie TTS character before reload", exc_info=True)
        gc.collect()
        self._loaded_model_key = None
        self._reference_key = None

    def synthesize(
        self,
        *,
        text: str,
        output_path: str | Path,
        model_dir: str | Path | None = None,
        language: str | None = None,
        reference_audio_path: str | Path | None = None,
        reference_text: str | None = None,
        part_silence_seconds: float = GENIE_TTS_PART_SILENCE_SECONDS,
        split_text: bool = True,
    ) -> dict[str, Any]:
        normalized = str(text or "").strip()
        if not normalized:
            raise ValueError("text cannot be empty")
        started_at = time.perf_counter()
        target = Path(output_path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        effective_model_dir = Path(model_dir).expanduser().resolve() if model_dir else self.model_dir
        effective_language = language or self.language
        effective_reference_audio = Path(reference_audio_path).expanduser().resolve() if reference_audio_path else self.reference_audio
        effective_reference_text = reference_text if reference_text is not None else self.reference_text.read_text(encoding="utf-8").strip()
        with self._lock:
            self._load(
                model_dir=effective_model_dir,
                language=effective_language,
                reference_audio=effective_reference_audio,
                reference_text=effective_reference_text,
            )
            parts = split_text_for_tts(normalized) if split_text else [normalized]
            part_paths: list[Path] = []
            if len(parts) == 1:
                self._synthesize_part(parts[0], target)
            else:
                try:
                    for index, part in enumerate(parts):
                        part_path = target.with_name(f"{target.stem}.part{index:03d}{target.suffix}")
                        self._synthesize_part(part, part_path)
                        part_paths.append(part_path)
                    concatenate_audio(part_paths, target, part_silence_seconds=part_silence_seconds)
                finally:
                    for part_path in part_paths:
                        try:
                            part_path.unlink(missing_ok=True)
                        except Exception:
                            logging.warning("failed to remove temporary Genie TTS part: %s", part_path)
        if not target.is_file() or target.stat().st_size <= 0:
            raise RuntimeError(f"Genie TTS did not create output audio: {target}")
        return {
            "audioPath": str(target),
            "durationSeconds": None,
            "elapsedSeconds": time.perf_counter() - started_at,
        }

    def stream(
        self,
        *,
        text: str,
        model_dir: str | Path | None = None,
        language: str | None = None,
        reference_audio_path: str | Path | None = None,
        reference_text: str | None = None,
        split_text: bool = True,
    ) -> Iterator[bytes]:
        normalized = str(text or "").strip()
        if not normalized:
            raise ValueError("text cannot be empty")
        effective_model_dir = Path(model_dir).expanduser().resolve() if model_dir else self.model_dir
        effective_language = language or self.language
        effective_reference_audio = Path(reference_audio_path).expanduser().resolve() if reference_audio_path else self.reference_audio
        effective_reference_text = reference_text if reference_text is not None else self.reference_text.read_text(encoding="utf-8").strip()
        with self._lock:
            self._load(
                model_dir=effective_model_dir,
                language=effective_language,
                reference_audio=effective_reference_audio,
                reference_text=effective_reference_text,
            )
            parts = split_text_for_tts(normalized) if split_text else [normalized]
            for part in parts:
                yield from iterate_async_bytes(genie.tts_async(
                    character_name=self.character_name,
                    text=part,
                    play=False,
                    split_sentence=False,
                    save_path=None,
                ))

    def _synthesize_part(self, text: str, target: Path) -> None:
        log_memory("before_tts_part")
        reset_memory_peak("tts_part")
        genie.tts(
            character_name=self.character_name,
            text=text,
            play=False,
            split_sentence=False,
            save_path=str(target),
        )
        log_memory_peak("tts_part")
        release_genie_auxiliary_models(speaker_verification=True)
        log_memory("after_tts_part")
        if not target.is_file() or target.stat().st_size <= 0:
            raise RuntimeError(f"Genie TTS did not create output audio: {target}")


def split_text_for_tts(text: str, max_chars: int = 10) -> list[str]:
    pieces = split_text_by_symbols(text)
    if not pieces:
        return [text]
    parts: list[str] = []
    current = ""
    for piece in pieces:
        current = f"{current}{piece}".strip()
        if len(current) > max_chars:
            parts.append(current)
            current = ""
    if current:
        if len(current) < max_chars and parts:
            parts[-1] = f"{parts[-1]}{current}".strip()
        else:
            parts.append(current)
    return parts or [text]


def split_text_by_symbols(text: str) -> list[str]:
    pieces: list[str] = []
    current: list[str] = []
    for char in text:
        current.append(char)
        if is_split_symbol(char):
            part = "".join(current).strip()
            if part:
                pieces.append(part)
            current = []
    tail = "".join(current).strip()
    if tail:
        pieces.append(tail)
    return pieces


def is_split_symbol(char: str) -> bool:
    category = unicodedata.category(char)
    return category.startswith("P") or category.startswith("S")


def iterate_async_bytes(source: AsyncIterator[bytes]) -> Iterator[bytes]:
    loop = asyncio.new_event_loop()
    try:
        while True:
            try:
                yield loop.run_until_complete(source.__anext__())
            except StopAsyncIteration:
                break
    finally:
        loop.close()


def concatenate_audio(paths: list[Path], output_path: Path, *, part_silence_seconds: float = GENIE_TTS_PART_SILENCE_SECONDS) -> None:
    if not paths:
        raise ValueError("no Genie TTS audio parts to concatenate")
    if part_silence_seconds < 0:
        raise ValueError("partSilenceSeconds cannot be negative")
    sample_rate: int | None = None
    chunks: list[np.ndarray] = []
    for index, path in enumerate(paths):
        data, current_sample_rate = sf.read(path, always_2d=True)
        if sample_rate is None:
            sample_rate = int(current_sample_rate)
        elif sample_rate != int(current_sample_rate):
            raise RuntimeError(f"Genie TTS audio parts have different sample rates: {sample_rate} vs {current_sample_rate}")
        if index > 0 and part_silence_seconds > 0:
            silence_frames = max(1, round((sample_rate or 32_000) * part_silence_seconds))
            chunks.append(np.zeros((silence_frames, data.shape[1]), dtype=data.dtype))
        chunks.append(data)
    combined = np.concatenate(chunks, axis=0)
    sf.write(output_path, combined, sample_rate or 32_000)


class GenieHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    runtime: GenieRuntime
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
        if self.path == "/stream":
            self.stream_synthesis()
            return
        if self.path != "/synthesize":
            self.write_json(404, {"ok": False, "error": "not found"})
            return
        try:
            body = self.read_json_body()
            result = self.runtime.synthesize(
                text=required_string(body, "text"),
                output_path=required_string(body, "outputPath"),
                model_dir=optional_string(body, "modelDir"),
                language=optional_string(body, "language"),
                reference_audio_path=optional_string(body, "referenceAudioPath"),
                reference_text=optional_string(body, "referenceText"),
                part_silence_seconds=optional_float(body, "partSilenceSeconds", GENIE_TTS_PART_SILENCE_SECONDS),
                split_text=optional_bool(body, "splitText", True),
            )
            self.write_json(200, {"ok": True, **result})
        except (BrokenPipeError, ConnectionResetError) as error:
            logging.warning("client disconnected before synthesize response could be written: %s", error)
        except Exception as error:
            logging.exception("synthesize failed")
            self.try_write_json(500, {"ok": False, "error": str(error)})

    def stream_synthesis(self) -> None:
        headers_sent = False
        try:
            body = self.read_json_body()
            stream = self.runtime.stream(
                text=required_string(body, "text"),
                model_dir=optional_string(body, "modelDir"),
                language=optional_string(body, "language"),
                reference_audio_path=optional_string(body, "referenceAudioPath"),
                reference_text=optional_string(body, "referenceText"),
                split_text=optional_bool(body, "splitText", True),
            )
            first_chunk = next(stream, None)
            self.send_response(200)
            self.send_header("content-type", "audio/L16; rate=32000; channels=1")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            headers_sent = True
            if first_chunk:
                self.write_stream_chunk(first_chunk)
            for chunk in stream:
                if not chunk:
                    continue
                self.write_stream_chunk(chunk)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError) as error:
            logging.warning("client disconnected during stream synthesize response: %s", error)
        except Exception as error:
            logging.exception("stream synthesize failed")
            if not headers_sent:
                self.try_write_json(500, {"ok": False, "error": str(error)})

    def write_stream_chunk(self, chunk: bytes) -> None:
        self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
        self.wfile.write(chunk)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

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

    def try_write_json(self, status: int, body: dict[str, Any]) -> None:
        try:
            self.write_json(status, body)
        except (BrokenPipeError, ConnectionResetError) as error:
            logging.warning("client disconnected before error response could be written: %s", error)


def required_string(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def optional_string(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value.strip() or None


def optional_float(body: dict[str, Any], key: str, default: float) -> float:
    value = body.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} must be a number")
    return float(value)


def optional_bool(body: dict[str, Any], key: str, default: bool) -> bool:
    value = body.get(key)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"{key} must be a boolean")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Alice Genie-TTS HTTP service")
    parser.add_argument("--host", default=os.environ.get("GENIE_TTS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("GENIE_TTS_PORT", "8767")))
    parser.add_argument("--model-dir", default=os.environ.get("GENIE_TTS_MODEL_DIR", "assets/tts/genie/models/alice"))
    parser.add_argument("--output-dir", default=os.environ.get("GENIE_TTS_OUTPUT_DIR", "assets/generated/tts"))
    parser.add_argument("--character-name", default=os.environ.get("GENIE_TTS_CHARACTER_NAME", "alice"))
    parser.add_argument("--language", default=os.environ.get("GENIE_TTS_LANGUAGE", "zh"))
    parser.add_argument("--reference-audio", default=os.environ.get("GENIE_TTS_REFERENCE_AUDIO", "assets/tts/references/alice/reference.wav"))
    parser.add_argument("--reference-text", default=os.environ.get("GENIE_TTS_REFERENCE_TEXT", "assets/tts/references/alice/reference.txt"))
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[genie-tts] %(asctime)s %(levelname)s %(message)s")
    start_memory_peak_sampler()
    args = parse_args()
    Path(args.output_dir).expanduser().resolve().mkdir(parents=True, exist_ok=True)
    runtime = GenieRuntime(
        character_name=args.character_name,
        model_dir=args.model_dir,
        language=args.language,
        reference_audio=args.reference_audio,
        reference_text=args.reference_text,
    )
    shutdown_event = threading.Event()
    GenieHandler.runtime = runtime
    GenieHandler.shutdown_event = shutdown_event
    server = ThreadingHTTPServer((args.host, args.port), GenieHandler)

    def request_shutdown(_signum: int, _frame: Any) -> None:
        shutdown_event.set()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    logging.info(
        "ready host=%s port=%s model_dir=%s character=%s lazy_model_load=true",
        args.host,
        args.port,
        Path(args.model_dir).resolve(),
        args.character_name,
    )
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    shutdown_event.wait()
    server.shutdown()
    server.server_close()
    logging.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
