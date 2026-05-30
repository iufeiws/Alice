from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

os.environ.setdefault("GENIE_DATA_DIR", "assets/tts/genie/GenieData")

import genie_tts as genie
import numpy as np
import soundfile as sf

GENIE_TTS_PART_SILENCE_SECONDS = 2 / 3


def disable_genie_audio_playback() -> None:
    try:
        from genie_tts.Core.TTSPlayer import tts_player
    except Exception:
        return

    def skip_playback_worker_loop() -> None:
        tts_player._playback_done_event.set()

    tts_player._playback_worker_loop = skip_playback_worker_loop


disable_genie_audio_playback()


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
        self._load()

    def _load(self) -> None:
        if not self.model_dir.is_dir():
            raise FileNotFoundError(f"Genie model directory was not found: {self.model_dir}")
        if not self.reference_audio.is_file():
            raise FileNotFoundError(f"Genie reference audio was not found: {self.reference_audio}")
        if not self.reference_text.is_file():
            raise FileNotFoundError(f"Genie reference text was not found: {self.reference_text}")
        audio_text = self.reference_text.read_text(encoding="utf-8").strip()
        if not audio_text:
            raise ValueError(f"Genie reference text is empty: {self.reference_text}")
        genie.load_character(
            character_name=self.character_name,
            onnx_model_dir=str(self.model_dir),
            language=self.language,
        )
        genie.set_reference_audio(
            character_name=self.character_name,
            audio_path=str(self.reference_audio),
            audio_text=audio_text,
            language=self.language,
        )

    def synthesize(self, *, text: str, output_path: str | Path) -> dict[str, Any]:
        normalized = str(text or "").strip()
        if not normalized:
            raise ValueError("text cannot be empty")
        started_at = time.perf_counter()
        target = Path(output_path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        parts = split_text_for_tts(normalized)
        part_paths: list[Path] = []
        if len(parts) == 1:
            self._synthesize_part(parts[0], target)
        else:
            try:
                for index, part in enumerate(parts):
                    part_path = target.with_name(f"{target.stem}.part{index:03d}{target.suffix}")
                    self._synthesize_part(part, part_path)
                    part_paths.append(part_path)
                concatenate_audio(part_paths, target)
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

    def _synthesize_part(self, text: str, target: Path) -> None:
        genie.tts(
            character_name=self.character_name,
            text=text,
            play=False,
            split_sentence=False,
            save_path=str(target),
        )
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


def concatenate_audio(paths: list[Path], output_path: Path) -> None:
    if not paths:
        raise ValueError("no Genie TTS audio parts to concatenate")
    sample_rate: int | None = None
    chunks: list[np.ndarray] = []
    for index, path in enumerate(paths):
        data, current_sample_rate = sf.read(path, always_2d=True)
        if sample_rate is None:
            sample_rate = int(current_sample_rate)
        elif sample_rate != int(current_sample_rate):
            raise RuntimeError(f"Genie TTS audio parts have different sample rates: {sample_rate} vs {current_sample_rate}")
        if index > 0:
            silence_frames = max(1, round((sample_rate or 32_000) * GENIE_TTS_PART_SILENCE_SECONDS))
            chunks.append(np.zeros((silence_frames, data.shape[1]), dtype=data.dtype))
        chunks.append(data)
    combined = np.concatenate(chunks, axis=0)
    sf.write(output_path, combined, sample_rate or 32_000)


class GenieHandler(BaseHTTPRequestHandler):
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
        if self.path != "/synthesize":
            self.write_json(404, {"ok": False, "error": "not found"})
            return
        try:
            body = self.read_json_body()
            result = self.runtime.synthesize(
                text=required_string(body, "text"),
                output_path=required_string(body, "outputPath"),
            )
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
    logging.info("ready host=%s port=%s model_dir=%s character=%s", args.host, args.port, Path(args.model_dir).resolve(), args.character_name)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    shutdown_event.wait()
    server.shutdown()
    server.server_close()
    logging.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
