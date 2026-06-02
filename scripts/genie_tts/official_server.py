from __future__ import annotations

import argparse
import os

os.environ.setdefault("GENIE_DATA_DIR", "assets/tts/genie/GenieData")

import genie_tts as genie


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the official Genie-TTS FastAPI server")
    parser.add_argument("--host", default=os.environ.get("GENIE_TTS_OFFICIAL_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("GENIE_TTS_OFFICIAL_PORT", "8788")))
    parser.add_argument("--workers", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    genie.start_server(host=args.host, port=args.port, workers=args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
