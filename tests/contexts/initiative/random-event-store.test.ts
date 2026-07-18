import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJsonRandomEventStore } from "../../../src/contexts/initiative/src/adapters/json-random-event-store.js";
import { tempPath } from "./initiated-behaviors-helpers.js";

function definition(id: string, content = "hello") {
  return {
    meta: { id, enabled: true, weight: 2, priority: 0 },
    messages: [{ meta: { title: "Instruction", enabled: true }, role: "user" as const, content }]
  };
}

test("random event store creates, updates, deletes, and does not resurrect files", () => {
  const root = tempPath("random-event-store", "events");
  const store = createJsonRandomEventStore(root);

  assert.equal(store.create(definition("care"))?.meta.id, "care");
  assert.equal(store.create(definition("care")), undefined);
  assert.equal(store.save({ ...definition("care"), meta: { ...definition("care").meta, weight: 4 } }).meta.weight, 4);
  assert.equal(store.list()[0].meta.weight, 4);
  assert.equal(store.plan(store.get("care")!).kind, "randomized");
  assert.equal(store.delete("care")?.meta.id, "care");
  assert.equal(createJsonRandomEventStore(root).get("care"), undefined);
});

test("random event store rejects invalid definitions and symbolic links", () => {
  const root = tempPath("random-event-invalid", "events");
  const store = createJsonRandomEventStore(root);
  assert.throws(() => store.save(definition("../escape")), /invalid_random_event_id/);
  assert.throws(() => store.save({ ...definition("bad"), meta: { ...definition("bad").meta, weight: Number.NaN } }), /weight/);
  assert.throws(() => store.save({ ...definition("bad"), messages: [{ ...definition("x").messages[0], role: "tool_request" as any }] }), /message_role/);
  assert.throws(() => store.save({ ...definition("bad"), messages: [{ ...definition("x").messages[0], role: "assistant", toolCalls: [{ id: "", type: "function", function: { name: "Chat", arguments: "{}" } }] }] }), /tool_call/);

  const target = tempPath("random-event-link-target", "link.json");
  fs.writeFileSync(target, JSON.stringify(definition("link")));
  fs.symlinkSync(target, path.join(root, "link.json"));
  assert.throws(() => store.list(), /invalid_random_event_file/);
});
