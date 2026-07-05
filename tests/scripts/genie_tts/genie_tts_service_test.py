from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


sys.dont_write_bytecode = True
SERVICE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "genie_tts" / "service.py"


class GenieTtsTextSplitTest(unittest.TestCase):
    def test_splits_on_sentence_endings(self) -> None:
        fake_genie = make_file_tts_genie([])

        with loaded_service("sentence_split", genie=fake_genie) as module:
            parts = module.split_text_by_symbols("嗯，之前只拆句号。问号？现在，符号！后面．没")

        self.assertEqual(parts, ["嗯，之前只拆句号。", "问号？", "现在，符号！", "后面．", "没"])

    def test_batches_split_text_over_ten_chars(self) -> None:
        fake_genie = make_file_tts_genie([])

        with loaded_service("text_batch", genie=fake_genie) as module:
            parts = module.split_text_for_tts("嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面．再来一点。没")

        self.assertEqual(parts, ["嗯，之前只拆句号。问号？", "现在，符号！都拆开；再拼接。后面．再来一点。没"])

    def test_synthesize_sends_split_parts_to_downstream_tts(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
            calls: list[dict[str, object]] = []
            fake_genie = make_file_tts_genie(calls)
            fake_numpy, fake_soundfile = make_audio_modules()

            with loaded_service("synthesize_downstream_split", genie=fake_genie, numpy=fake_numpy, soundfile=fake_soundfile) as module:
                runtime = make_runtime(module, tmp_path)
                runtime.synthesize(
                    text="嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面．再来一点。没",
                    output_path=tmp_path / "out.wav",
                    part_silence_seconds=0.25,
                )

            tts_calls = calls_for(calls, "tts")
            self.assertEqual(
                [call["text"] for call in tts_calls],
                ["嗯，之前只拆句号。问号？", "现在，符号！都拆开；再拼接。后面．再来一点。没"],
            )
            self.assertTrue(all(call["split_sentence"] is False for call in tts_calls))

    def test_synthesize_inserts_silence_between_split_parts(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
            calls: list[dict[str, object]] = []
            concatenate_chunks: list[object] = []
            fake_genie = make_file_tts_genie(calls)
            fake_numpy, fake_soundfile = make_audio_modules(
                concatenate=lambda chunks, axis=0: _capture_concatenate(concatenate_chunks, chunks),
            )

            with loaded_service("synthesize_part_silence", genie=fake_genie, numpy=fake_numpy, soundfile=fake_soundfile) as module:
                runtime = make_runtime(module, tmp_path)
                runtime.synthesize(
                    text="嗯，之前只拆句号。问号？现在，符号！都拆开；再拼接。后面．再来一点。没",
                    output_path=tmp_path / "out.wav",
                    part_silence_seconds=0.25,
                )

            self.assertEqual([chunk.shape for chunk in concatenate_chunks], [(16, 1), (8000, 1), (16, 1)])

    def test_can_disable_text_split(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
            calls: list[dict[str, object]] = []
            fake_genie = make_file_tts_genie(calls)
            fake_numpy, fake_soundfile = make_audio_modules()

            with loaded_service("disable_split", genie=fake_genie, numpy=fake_numpy, soundfile=fake_soundfile) as module:
                runtime = make_runtime(module, tmp_path)
                text = "嗯，之前会拆句号。问号？现在不拆。"
                runtime.synthesize(text=text, output_path=tmp_path / "out.wav", split_text=False)

            tts_calls = calls_for(calls, "tts")
            self.assertEqual(len(tts_calls), 1)
            self.assertEqual(tts_calls[0]["text"], "嗯，之前会拆句号。问号？现在不拆。")
            self.assertIs(tts_calls[0]["split_sentence"], False)
            self.assertTrue((tmp_path / "out.wav").is_file())


class GenieTtsStreamingTest(unittest.TestCase):
    def test_streams_tts_chunks(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
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

            with loaded_service("stream", genie=fake_genie) as module:
                runtime = make_runtime(module, tmp_path)
                chunks = list(runtime.stream(text="第一句第一句第一句啊。第二句第二句第二句啊。", split_text=True))

            self.assertEqual(
                chunks,
                [
                    "第一句第一句第一句啊。:a".encode("utf-8"),
                    "第一句第一句第一句啊。:b".encode("utf-8"),
                    "第二句第二句第二句啊。:a".encode("utf-8"),
                    "第二句第二句第二句啊。:b".encode("utf-8"),
                ],
            )

    def test_stream_sends_split_parts_to_downstream_tts(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
            calls: list[dict[str, object]] = []

            async def fake_tts_async(**kwargs: object):
                calls.append({"method": "tts_async", **kwargs})
                yield b"chunk"

            fake_genie = types.SimpleNamespace(
                load_character=lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
                set_reference_audio=lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
                tts_async=fake_tts_async,
            )

            with loaded_service("stream_downstream_split", genie=fake_genie) as module:
                runtime = make_runtime(module, tmp_path)
                list(runtime.stream(text="第一句第一句第一句啊。第二句第二句第二句啊。", split_text=True))

            tts_calls = calls_for(calls, "tts_async")
            self.assertEqual([call["text"] for call in tts_calls], ["第一句第一句第一句啊。", "第二句第二句第二句啊。"])
            self.assertTrue(all(call["split_sentence"] is False for call in tts_calls))
            self.assertTrue(all(call["save_path"] is None for call in tts_calls))


class GenieTtsConfigurationTest(unittest.TestCase):
    def test_reloads_character_when_language_changes(self) -> None:
        with make_temp_dir() as temp_dir:
            tmp_path = Path(temp_dir)
            calls: list[dict[str, object]] = []
            fake_genie = make_file_tts_genie(calls, unload=True)
            fake_numpy, fake_soundfile = make_audio_modules()

            with loaded_service("language_reload", genie=fake_genie, numpy=fake_numpy, soundfile=fake_soundfile) as module:
                runtime = make_runtime(module, tmp_path)
                runtime.synthesize(text="中文。", output_path=tmp_path / "zh.wav", language="zh")
                runtime.synthesize(text="日本語。", output_path=tmp_path / "jp.wav", language="jp", reference_text="参照テキスト")

            self.assertEqual(
                [call["method"] for call in calls if call["method"] != "tts"],
                ["load_character", "set_reference_audio", "unload_character", "load_character", "set_reference_audio"],
            )
            self.assertEqual([call["language"] for call in calls_for(calls, "load_character")], ["zh", "jp"])
            self.assertEqual([call["language"] for call in calls_for(calls, "set_reference_audio")], ["zh", "jp"])

    def test_disables_roberta_by_default(self) -> None:
        fake_genie = types.ModuleType("genie_tts")
        fake_model_manager = types.SimpleNamespace(
            roberta_model=object(),
            roberta_tokenizer=object(),
            load_roberta_model=lambda *_args, **_kwargs: True,
        )
        fake_model_manager_module = types.ModuleType("genie_tts.ModelManager")
        fake_model_manager_module.model_manager = fake_model_manager

        with patched_modules(
            {
                "genie_tts": fake_genie,
                "genie_tts.ModelManager": fake_model_manager_module,
                "numpy": types.SimpleNamespace(),
                "soundfile": types.SimpleNamespace(),
            },
            {"GENIE_TTS_ENABLE_ROBERTA": None},
        ):
            load_service("roberta")

        self.assertIs(fake_model_manager.load_roberta_model(), False)
        self.assertIsNone(fake_model_manager.roberta_model)
        self.assertIsNone(fake_model_manager.roberta_tokenizer)


class GenieTtsHttpContractTest(unittest.TestCase):
    def test_treats_broken_pipe_as_client_disconnect(self) -> None:
        fake_genie = types.SimpleNamespace()
        writes: list[tuple[int, dict[str, object]]] = []

        with loaded_service("broken_pipe", genie=fake_genie) as module:
            output_path = str(Path(tempfile.gettempdir()) / "alice-tests" / "voice.wav")
            handler = object.__new__(module.GenieHandler)
            handler.path = "/synthesize"
            handler.read_json_body = lambda: {"text": "hello", "outputPath": output_path}
            handler.runtime = types.SimpleNamespace(synthesize=lambda **_kwargs: {"audioPath": output_path})

            def write_json(status: int, body: dict[str, object]) -> None:
                writes.append((status, body))
                raise BrokenPipeError("client closed")

            handler.write_json = write_json
            with self.assertLogs(level="WARNING") as logs:
                handler.do_POST()

        self.assertEqual([status for status, _body in writes], [200])
        self.assertTrue(any("client disconnected before synthesize response" in message for message in logs.output))


def make_temp_dir() -> tempfile.TemporaryDirectory[str]:
    root = Path(tempfile.gettempdir()) / "alice-tests"
    root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=root)


@contextmanager
def loaded_service(
    suffix: str,
    *,
    genie: object,
    numpy: object | None = None,
    soundfile: object | None = None,
) -> Iterator[types.ModuleType]:
    with patched_modules(
        {
            "genie_tts": genie,
            "numpy": numpy or types.SimpleNamespace(),
            "soundfile": soundfile or types.SimpleNamespace(),
        }
    ):
        yield load_service(suffix)


@contextmanager
def patched_modules(modules: dict[str, object], env: dict[str, str | None] | None = None) -> Iterator[None]:
    missing = object()
    previous_modules = {name: sys.modules.get(name, missing) for name in modules}
    previous_env = {name: os.environ.get(name, missing) for name in env or {}}
    sys.modules.update(modules)
    for name, value in (env or {}).items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    try:
        yield
    finally:
        for name, previous in previous_modules.items():
            if previous is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
        for name, previous in previous_env.items():
            if previous is missing:
                os.environ.pop(name, None)
            else:
                os.environ[name] = str(previous)


def load_service(suffix: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(f"alice_genie_service_{suffix}_test_target", SERVICE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_runtime(module: types.ModuleType, tmp_path: Path, *, language: str = "zh") -> Any:
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"wav")
    reference_text = tmp_path / "reference.txt"
    reference_text.write_text("参考文本", encoding="utf-8")
    return module.GenieRuntime(
        character_name="alice",
        model_dir=model_dir,
        language=language,
        reference_audio=reference_audio,
        reference_text=reference_text.read_text(encoding="utf-8"),
    )


def make_file_tts_genie(calls: list[dict[str, object]], *, unload: bool = False) -> types.SimpleNamespace:
    methods: dict[str, object] = {
        "load_character": lambda **kwargs: calls.append({"method": "load_character", **kwargs}),
        "set_reference_audio": lambda **kwargs: calls.append({"method": "set_reference_audio", **kwargs}),
        "tts": lambda **kwargs: _write_fake_audio(calls, kwargs),
    }
    if unload:
        methods["unload_character"] = lambda **kwargs: calls.append({"method": "unload_character", **kwargs})
    return types.SimpleNamespace(**methods)


def make_audio_modules(*, concatenate: object | None = None) -> tuple[types.SimpleNamespace, types.SimpleNamespace]:
    fake_numpy = types.SimpleNamespace(
        concatenate=concatenate or (lambda chunks, axis=0: b"combined"),
        zeros=lambda shape, dtype: FakeAudio(shape=shape, dtype=dtype),
    )
    fake_soundfile = types.SimpleNamespace(
        read=lambda path, always_2d=True: (FakeAudio(shape=(16, 1), dtype="float64"), 32_000),
        write=lambda path, data, sample_rate: Path(path).write_bytes(b"combined"),
    )
    return fake_numpy, fake_soundfile


def calls_for(calls: list[dict[str, object]], method: str) -> list[dict[str, object]]:
    return [call for call in calls if call.get("method") == method]


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
