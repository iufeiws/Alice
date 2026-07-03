import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferTtsStreamInput } from "../../../src/channels/tts/src/stream-input-buffer.js";

test("TTS stream input buffer emits a complete final sentence", async () => {
  const parts = await collect(bufferTtsStreamInput(["第一段够长了。"], {
    minChars: 6,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["第一段够长了。"]);
});

test("TTS stream input buffer only treats configured sentence endings as speech boundaries", async () => {
  const parts = await collect(bufferTtsStreamInput(["第一段，逗号不断；分号不断．第二段？第三"], {
    minChars: 6,
    allowCrossNewline: true
  }));

  assert.deepEqual(parts, ["第一段，逗号不断；分号不断．", "第二段？第三"]);
});

test("TTS stream input buffer flushes buffered chunk text at newline", async () => {
  const parts = await collect(bufferTtsStreamInput(["abcdefghijklmn", "abc", "\nnext sentence。"], {
    minChars: 12,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["abcdefghijklmnabc", "next sentence。"]);
});

test("TTS stream input buffer removes empty lines", async () => {
  const parts = await collect(bufferTtsStreamInput(["\n\nnext sentence。"], {
    minChars: 12,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["next sentence。"]);
});

test("TTS stream input buffer does not cross newline when translation is disabled", async () => {
  const parts = await collect(bufferTtsStreamInput(["hello world!\nsecond line!"], {
    minChars: 5,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["hello world!", "second line!"]);
});

test("TTS stream input buffer keeps final short line separate when translation is disabled", async () => {
  const parts = await collect(bufferTtsStreamInput(["hello world!\nabc"], {
    minChars: 12,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["hello world!", "abc"]);
});

test("TTS stream input buffer can preserve newline inside translated source parts", async () => {
  const parts = await collect(bufferTtsStreamInput(["first line。\nsecond line。third line。"], {
    minChars: 8,
    allowCrossNewline: true
  }));

  assert.deepEqual(parts, ["first line。\nsecond line。", "third line。"]);
});

async function collect(input: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const part of input) output.push(part);
  return output;
}
