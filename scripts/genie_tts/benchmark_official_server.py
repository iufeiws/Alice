from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def rss_mb(pid: int) -> float | None:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
    except Exception:
        return None
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) / 1024
    return None


class RssSampler:
    def __init__(self, pid: int, interval_seconds: float = 0.05) -> None:
        self.pid = pid
        self.interval_seconds = interval_seconds
        self.max_rss = 0.0
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.running = False
        self.thread.join(timeout=1)

    def reset(self) -> None:
        self.max_rss = rss_mb(self.pid) or 0.0

    def _run(self) -> None:
        while self.running:
            current = rss_mb(self.pid)
            if current is not None and current > self.max_rss:
                self.max_rss = current
            time.sleep(self.interval_seconds)


def post_json(base_url: str, path: str, payload: dict[str, Any], *, timeout: float = 180) -> bytes:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def wait_for_server(base_url: str, process: subprocess.Popen[bytes], timeout_seconds: float = 120) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "not ready"
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"official Genie server exited before ready: {process.poll()}")
        try:
            post_json(base_url, "/stop", {}, timeout=2)
            return
        except Exception as error:
            last_error = str(error)
            time.sleep(0.5)
    raise RuntimeError(f"official Genie server did not become ready: {last_error}")


def run(args: argparse.Namespace) -> int:
    output_path = Path(args.output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    server_script = Path("scripts/genie_tts/official_server.py").resolve()
    env = {
        **os.environ,
        "GENIE_DATA_DIR": str(Path(args.data_dir).resolve()),
        "PYTHONUNBUFFERED": "1",
    }
    process = subprocess.Popen(
        [args.python, str(server_script), "--host", args.host, "--port", str(args.port), "--workers", "1"],
        cwd=Path.cwd(),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    sampler = RssSampler(process.pid)
    sampler.start()
    log_lines: list[str] = []

    def drain_output() -> None:
        assert process.stdout is not None
        for raw in iter(process.stdout.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            log_lines.append(line)
            print(f"[official-server] {line}")

    output_thread = threading.Thread(target=drain_output, daemon=True)
    output_thread.start()

    base_url = f"http://{args.host}:{args.port}"
    try:
        print(f"server_pid={process.pid}")
        wait_for_server(base_url, process)
        print(f"rss_after_start_mb={rss_mb(process.pid):.1f} peak_mb={sampler.max_rss:.1f}")

        sampler.reset()
        started = time.perf_counter()
        post_json(base_url, "/load_character", {
            "character_name": args.character_name,
            "onnx_model_dir": str(Path(args.model_dir).resolve()),
            "language": args.language,
        })
        print(
            "load_character "
            f"elapsed_s={time.perf_counter() - started:.2f} "
            f"rss_mb={rss_mb(process.pid):.1f} peak_mb={sampler.max_rss:.1f}"
        )

        sampler.reset()
        started = time.perf_counter()
        post_json(base_url, "/set_reference_audio", {
            "character_name": args.character_name,
            "audio_path": str(Path(args.reference_audio).resolve()),
            "audio_text": args.reference_text,
            "language": args.language,
        })
        print(
            "set_reference_audio "
            f"elapsed_s={time.perf_counter() - started:.2f} "
            f"rss_mb={rss_mb(process.pid):.1f} peak_mb={sampler.max_rss:.1f}"
        )

        sampler.reset()
        started = time.perf_counter()
        data = post_json(base_url, "/tts", {
            "character_name": args.character_name,
            "text": args.text,
            "split_sentence": False,
            "save_path": str(output_path),
        }, timeout=args.timeout)
        print(
            "tts "
            f"elapsed_s={time.perf_counter() - started:.2f} "
            f"rss_mb={rss_mb(process.pid):.1f} peak_mb={sampler.max_rss:.1f} "
            f"response_bytes={len(data)} output_exists={output_path.is_file()} output_bytes={output_path.stat().st_size if output_path.is_file() else 0}"
        )
    finally:
        sampler.stop()
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        output_thread.join(timeout=1)
        print(f"server_exit={process.returncode}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark the official Genie-TTS server memory usage")
    parser.add_argument("--python", default=".conda-moss/bin/python")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--data-dir", default="assets/tts/genie/GenieData")
    parser.add_argument("--model-dir", default="assets/plugin/japanese-voice/model")
    parser.add_argument("--reference-audio", default="assets/plugin/japanese-voice/tts_sorce.mp3_0009628480_0009775040.wav")
    parser.add_argument("--reference-text", default="先輩が標本にでもなってくれますか?")
    parser.add_argument("--language", default="jp")
    parser.add_argument("--character-name", default="alice")
    parser.add_argument("--text", default="先輩、今日も少しだけ話してくれますか。")
    parser.add_argument("--output-path", default="assets/generated/tts/official_genie_server_smoke.wav")
    parser.add_argument("--timeout", type=float, default=240)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
