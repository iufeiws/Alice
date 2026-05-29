from __future__ import annotations

import importlib.util
import sys
import types
import unittest
import wave
from pathlib import Path


class GenieTtsServiceTest(unittest.TestCase):
    def test_genie_service_splits_on_periods_and_preserves_punctuation(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            _run_split_sentence_check(Path(temp_dir))


def _run_split_sentence_check(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    fake_genie = types.SimpleNamespace(
        load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        tts=lambda **kwargs: _write_fake_audio(calls, kwargs),
    )
    previous = sys.modules.get("genie_tts")
    sys.modules["genie_tts"] = fake_genie
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
        runtime.synthesize(text="第一句。Second sentence.可以吗？Really?没有句号", output_path=output_path)
    finally:
        if previous is None:
            sys.modules.pop("genie_tts", None)
        else:
            sys.modules["genie_tts"] = previous

    tts_calls = [call for call in calls if call.get("method") == "tts"]
    assert len(tts_calls) == 5
    assert [call["text"] for call in tts_calls] == ["第一句。", "Second sentence.", "可以吗？", "Really?", "没有句号"]
    assert all(call["split_sentence"] is False for call in tts_calls)
    assert (tmp_path / "out.wav").is_file()


def _write_fake_audio(calls: list[dict[str, object]], kwargs: dict[str, object]) -> None:
    calls.append({"method": "tts", **kwargs})
    with wave.open(str(kwargs["save_path"]), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(32_000)
        wav.writeframes(b"\x00\x00" * 16)


if __name__ == "__main__":
    unittest.main()
