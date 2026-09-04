export const LLM_STREAM_LOOP_MAX_PHRASE_CHARACTERS = 20;
export const LLM_STREAM_LOOP_REPETITIONS = 10;

export type LLMStreamLoopMatch = {
  phrase: string;
  phraseCharacters: number;
  repetitions: number;
};

export class LLMStreamLoopError extends Error {
  readonly match: LLMStreamLoopMatch;

  constructor(match: LLMStreamLoopMatch) {
    super("llm_stream_output_loop_detected");
    this.name = "LLMStreamLoopError";
    this.match = match;
  }
}

export function createLLMStreamLoopDetector(): {
  push(text: string): LLMStreamLoopMatch | undefined;
} {
  const tail: string[] = [];
  const maximumTailCharacters = LLM_STREAM_LOOP_MAX_PHRASE_CHARACTERS * LLM_STREAM_LOOP_REPETITIONS;

  return {
    push(text) {
      for (const character of text) {
        tail.push(character);
        if (tail.length > maximumTailCharacters) tail.shift();
        const match = matchRepeatedSuffix(tail);
        if (match) return match;
      }
      return undefined;
    }
  };
}

export function guardOpenAIStreamLoop(
  response: Response,
  protocol: "openai-chat-completions" | "openai-responses",
  onLoop: (match: LLMStreamLoopMatch) => void | Promise<void>
): Response {
  if (!response.body || !isSse(response.headers.get("content-type"))) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const detector = createLLMStreamLoopDetector();
  let lineBuffer = "";
  let stopped = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          lineBuffer += decoder.decode();
          const match = inspectSseLines(lineBuffer, protocol, detector);
          if (match) {
            await stopForLoop(controller, reader, match, onLoop);
            stopped = true;
            return;
          }
          controller.close();
          return;
        }

        lineBuffer += decoder.decode(next.value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        const match = inspectSseLines(lines.join("\n"), protocol, detector);
        if (match) {
          await stopForLoop(controller, reader, match, onLoop);
          stopped = true;
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        stopped = true;
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      stopped = true;
      return reader.cancel(reason);
    }
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });

  async function stopForLoop(
    controller: ReadableStreamDefaultController<Uint8Array>,
    source: ReadableStreamDefaultReader<Uint8Array>,
    match: LLMStreamLoopMatch,
    notify: (match: LLMStreamLoopMatch) => void | Promise<void>
  ): Promise<void> {
    if (stopped) return;
    const error = new LLMStreamLoopError(match);
    try {
      await notify(match);
    } catch {
      // Observability must not prevent the loop guard from cutting the stream.
    }
    await source.cancel(error).catch(() => undefined);
    controller.error(error);
  }
}

function inspectSseLines(
  text: string,
  protocol: "openai-chat-completions" | "openai-responses",
  detector: ReturnType<typeof createLLMStreamLoopDetector>
): LLMStreamLoopMatch | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const delta = visibleTextDelta(event, protocol);
    if (delta) {
      const match = detector.push(delta);
      if (match) return match;
    }
  }
  return undefined;
}

function visibleTextDelta(
  event: Record<string, unknown>,
  protocol: "openai-chat-completions" | "openai-responses"
): string | undefined {
  if (protocol === "openai-responses") {
    return event.type === "response.output_text.delta" && typeof event.delta === "string"
      ? event.delta
      : undefined;
  }
  const choice = Array.isArray(event.choices) ? objectValue(event.choices[0]) : undefined;
  const delta = objectValue(choice?.delta);
  return typeof delta?.content === "string" ? delta.content : undefined;
}

function matchRepeatedSuffix(characters: string[]): LLMStreamLoopMatch | undefined {
  const maximumPhraseCharacters = Math.min(
    LLM_STREAM_LOOP_MAX_PHRASE_CHARACTERS,
    Math.floor(characters.length / LLM_STREAM_LOOP_REPETITIONS)
  );
  for (let phraseCharacters = 1; phraseCharacters <= maximumPhraseCharacters; phraseCharacters += 1) {
    const repeatedCharacters = phraseCharacters * LLM_STREAM_LOOP_REPETITIONS;
    const start = characters.length - repeatedCharacters;
    let matches = true;
    for (let offset = phraseCharacters; offset < repeatedCharacters; offset += 1) {
      if (characters[start + offset] !== characters[start + (offset % phraseCharacters)]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        phrase: characters.slice(characters.length - phraseCharacters).join(""),
        phraseCharacters,
        repetitions: LLM_STREAM_LOOP_REPETITIONS
      };
    }
  }
  return undefined;
}

function isSse(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/event-stream") === true;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
