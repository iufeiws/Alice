import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferTtsStreamInput } from "../src/channels/tts/src/stream-input-buffer.js";

test("TTS stream input buffer waits for lookahead before yielding previous chunk", async () => {
  const iterator = bufferTtsStreamInput(["第一段够长了。"], { minChars: 6, allowCrossNewline: false })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: "第一段够长了。", done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("TTS stream input buffer merges short tail before newline and removes empty lines", async () => {
  const parts = await collect(bufferTtsStreamInput(["abcdefghijklmn", "abc", "\n\nnext sentence。"], {
    minChars: 12,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["abcdefghijklmnabc", "next sentence。"]);
});

test("TTS stream input buffer does not cross newline when translation is disabled", async () => {
  const parts = await collect(bufferTtsStreamInput(["hello world!\nsecond line!"], {
    minChars: 5,
    allowCrossNewline: false
  }));

  assert.deepEqual(parts, ["hello world!", "second line!"]);
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
