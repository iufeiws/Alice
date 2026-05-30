from __future__ import annotations

import importlib.util
import sys
import types
import unittest
import wave
from pathlib import Path


class GenieTtsServiceTest(unittest.TestCase):
    def test_genie_service_splits_on_symbols_and_batches_over_ten_chars(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            _run_split_sentence_check(Path(temp_dir))


def _run_split_sentence_check(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    concatenate_chunks: list[object] = []
    fake_genie = types.SimpleNamespace(
        load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        tts=lambda **kwargs: _write_fake_audio(calls, kwargs),
    )
    fake_numpy = types.SimpleNamespace(
        concatenate=lambda chunks, axis=0: _capture_concatenate(concatenate_chunks, chunks),
        zeros=lambda shape, dtype: FakeAudio(shape=shape, dtype=dtype),
    )
    fake_soundfile = types.SimpleNamespace(
        read=lambda path, always_2d=True: (FakeAudio(shape=(16, 1), dtype="float64"), 32_000),
        write=lambda path, data, sample_rate: Path(path).write_bytes(b"combined"),
    )
    previous_genie = sys.modules.get("genie_tts")
    previous_numpy = sys.modules.get("numpy")
    previous_soundfile = sys.modules.get("soundfile")
    sys.modules["genie_tts"] = fake_genie
    sys.modules["numpy"] = fake_numpy
    sys.modules["soundfile"] = fake_soundfile
    try:
        service_path = Path(__file__).resolve().parents[1] / "scripts" / "genie_tts" / "service.py"
        spec = importlib.util.spec_from_file_location("alice_genie_service_test_target", service_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        model_dir = tmp_path / "model"
        model_dir.mkdir()
        reference_audio = tmp_path / "reference.wav"
        reference_audio.write_bytes(b"wav")
        reference_text = tmp_path / "reference.txt"
        reference_text.write_text("参考文本", encoding="utf-8")
        runtime = module.GenieRuntime(
            character_name="alice",
            model_dir=model_dir,
            language="zh",
            reference_audio=reference_audio,
            reference_text=reference_text,
        )

        output_path = tmp_path / "out.wav"
        runtime.synthesize(text="嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面，再来一点。没", output_path=output_path)
    finally:
        if previous_genie is None:
            sys.modules.pop("genie_tts", None)
        else:
            sys.modules["genie_tts"] = previous_genie
        if previous_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = previous_numpy
        if previous_soundfile is None:
            sys.modules.pop("soundfile", None)
        else:
            sys.modules["soundfile"] = previous_soundfile

    tts_calls = [call for call in calls if call.get("method") == "tts"]
    assert len(tts_calls) == 2
    assert [call["text"] for call in tts_calls] == ["嗯，之前只拆句号。问号？", "现在，符号！都拆开；再拼接。后面，再来一点。没"]
    assert all(call["split_sentence"] is False for call in tts_calls)
    assert [chunk.shape for chunk in concatenate_chunks] == [(16, 1), (21333, 1), (16, 1)]
    assert (tmp_path / "out.wav").is_file()


class FakeAudio:
    def __init__(self, *, shape: tuple[int, int], dtype: str) -> None:
        self.shape = shape
        self.dtype = dtype


def _capture_concatenate(target: list[object], chunks: list[object]) -> bytes:
    target.extend(chunks)
    return b"combined"


def _write_fake_audio(calls: list[dict[str, object]], kwargs: dict[str, object]) -> None:
    calls.append({"method": "tts", **kwargs})
    with wave.open(str(kwargs["save_path"]), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(32_000)
        wav.writeframes(b"\x00\x00" * 16)


if __name__ == "__main__":
    unittest.main()
