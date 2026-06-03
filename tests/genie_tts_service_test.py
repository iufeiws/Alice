from __future__ import annotations

import importlib.util
import os
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

    def test_genie_service_can_disable_text_split(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            _run_disable_split_text_check(Path(temp_dir))

    def test_genie_service_streams_tts_chunks(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            _run_stream_tts_check(Path(temp_dir))

    def test_genie_service_reloads_character_when_language_changes(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            _run_language_reload_check(Path(temp_dir))

    def test_genie_service_disables_roberta_by_default(self) -> None:
        _run_roberta_disabled_by_default_check()


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
        assert calls == []

        output_path = tmp_path / "out.wav"
        runtime.synthesize(
            text="嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面，再来一点。没",
            output_path=output_path,
            part_silence_seconds=0.25,
        )
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
    assert [chunk.shape for chunk in concatenate_chunks] == [(16, 1), (8000, 1), (16, 1)]
    assert (tmp_path / "out.wav").is_file()


def _run_disable_split_text_check(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    fake_genie = types.SimpleNamespace(
        load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        tts=lambda **kwargs: _write_fake_audio(calls, kwargs),
    )
    fake_numpy = types.SimpleNamespace(
        concatenate=lambda chunks, axis=0: b"combined",
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
        spec = importlib.util.spec_from_file_location("alice_genie_service_no_split_test_target", service_path)
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
        text = "嗯，之前会拆句号。问号？现在不拆。"
        runtime.synthesize(
            text=text,
            output_path=tmp_path / "out.wav",
            split_text=False,
        )
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
    assert len(tts_calls) == 1
    assert tts_calls[0]["text"] == "嗯，之前会拆句号。问号？现在不拆。"
    assert tts_calls[0]["split_sentence"] is False
    assert (tmp_path / "out.wav").is_file()


def _run_stream_tts_check(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []

    async def fake_tts_async(**kwargs: object):
        calls.append({"method": "tts_async", **kwargs})
        text = str(kwargs["text"])
        yield f"{text}:a".encode("utf-8")
        yield f"{text}:b".encode("utf-8")

    fake_genie = types.SimpleNamespace(
        load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        tts_async=fake_tts_async,
    )
    fake_numpy = types.SimpleNamespace()
    fake_soundfile = types.SimpleNamespace()
    previous_genie = sys.modules.get("genie_tts")
    previous_numpy = sys.modules.get("numpy")
    previous_soundfile = sys.modules.get("soundfile")
    sys.modules["genie_tts"] = fake_genie
    sys.modules["numpy"] = fake_numpy
    sys.modules["soundfile"] = fake_soundfile
    try:
        service_path = Path(__file__).resolve().parents[1] / "scripts" / "genie_tts" / "service.py"
        spec = importlib.util.spec_from_file_location("alice_genie_service_stream_test_target", service_path)
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
        chunks = list(runtime.stream(text="第一句第一句第一句啊。第二句第二句第二句啊。", split_text=True))
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

    assert chunks == [
        "第一句第一句第一句啊。:a".encode("utf-8"),
        "第一句第一句第一句啊。:b".encode("utf-8"),
        "第二句第二句第二句啊。:a".encode("utf-8"),
        "第二句第二句第二句啊。:b".encode("utf-8"),
    ]
    tts_calls = [call for call in calls if call.get("method") == "tts_async"]
    assert [call["text"] for call in tts_calls] == ["第一句第一句第一句啊。", "第二句第二句第二句啊。"]
    assert all(call["split_sentence"] is False for call in tts_calls)
    assert all(call["save_path"] is None for call in tts_calls)


def _run_roberta_disabled_by_default_check() -> None:
    fake_genie = types.ModuleType("genie_tts")
    fake_numpy = types.SimpleNamespace()
    fake_soundfile = types.SimpleNamespace()
    fake_model_manager = types.SimpleNamespace(
        roberta_model=object(),
        roberta_tokenizer=object(),
        load_roberta_model=lambda *_args, **_kwargs: True,
    )
    fake_model_manager_module = types.ModuleType("genie_tts.ModelManager")
    fake_model_manager_module.model_manager = fake_model_manager

    previous_modules = {
        name: sys.modules.get(name)
        for name in ("genie_tts", "genie_tts.ModelManager", "numpy", "soundfile")
    }
    previous_enable_roberta = os.environ.get("GENIE_TTS_ENABLE_ROBERTA")
    sys.modules["genie_tts"] = fake_genie
    sys.modules["genie_tts.ModelManager"] = fake_model_manager_module
    sys.modules["numpy"] = fake_numpy
    sys.modules["soundfile"] = fake_soundfile
    os.environ.pop("GENIE_TTS_ENABLE_ROBERTA", None)
    try:
        service_path = Path(__file__).resolve().parents[1] / "scripts" / "genie_tts" / "service.py"
        spec = importlib.util.spec_from_file_location("alice_genie_service_roberta_test_target", service_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
        if previous_enable_roberta is None:
            os.environ.pop("GENIE_TTS_ENABLE_ROBERTA", None)
        else:
            os.environ["GENIE_TTS_ENABLE_ROBERTA"] = previous_enable_roberta

    assert fake_model_manager.load_roberta_model() is False
    assert fake_model_manager.roberta_model is None
    assert fake_model_manager.roberta_tokenizer is None


def _run_language_reload_check(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    fake_genie = types.SimpleNamespace(
        load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        unload_character=lambda **kwargs: calls.append({"method": "unload_character", **kwargs}),
        set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        tts=lambda **kwargs: _write_fake_audio(calls, kwargs),
    )
    fake_numpy = types.SimpleNamespace(
        concatenate=lambda chunks, axis=0: b"combined",
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
        spec = importlib.util.spec_from_file_location("alice_genie_service_reload_test_target", service_path)
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
        assert calls == []

        runtime.synthesize(text="中文。", output_path=tmp_path / "zh.wav", language="zh")
        runtime.synthesize(text="日本語。", output_path=tmp_path / "jp.wav", language="jp", reference_text="参照テキスト")
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

    assert [call["method"] for call in calls if call["method"] != "tts"] == [
        "load_character",
        "set_reference_audio",
        "unload_character",
        "load_character",
        "set_reference_audio",
    ]
    load_calls = [call for call in calls if call["method"] == "load_character"]
    reference_calls = [call for call in calls if call["method"] == "set_reference_audio"]
    assert [call["language"] for call in load_calls] == ["zh", "jp"]
    assert [call["language"] for call in reference_calls] == ["zh", "jp"]


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
