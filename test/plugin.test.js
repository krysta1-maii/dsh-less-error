import assert from "node:assert/strict";
import test from "node:test";
import { apply, inject, name } from "../lib/index.js";

function createHarness() {
  let listener;
  const ctx = {
    on(event, callback) {
      assert.equal(event, "llm/stream");
      listener = callback;
      return () => { listener = undefined; };
    },
  };
  assert.equal(apply(ctx), undefined);
  assert.equal(typeof listener, "function");
  return {
    listen: (options, next) => listener(options, next),
  };
}

test("declares the Cordis plugin identity and llm dependency", () => {
  assert.equal(name, "less-error");
  assert.deepEqual(inject, ["llm"]);
});

test("passes unrelated non-Codex failures through by identity", async () => {
  const harness = createHarness();
  const failure = {
    type: "finish",
    reason: { kind: "error", failure: { code: "PI_AI_ERROR", message: "No response body" } },
  };
  let calls = 0;
  const result = harness.listen({ provider: "moonshot" }, () => {
    calls += 1;
    return (async function* () { yield failure; })();
  });
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(calls, 1);
  assert.equal(chunks[0], failure);
});

test("repairs overload failures on non-Codex providers", async () => {
  const harness = createHarness();
  const failure = {
    type: "finish",
    reason: { kind: "error", failure: { code: "PI_AI_ERROR", message: "The engine is currently overloaded, please try again later" } },
  };
  const result = harness.listen({ provider: "moonshot" }, () => (async function* () { yield failure; })());
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(chunks[0].reason.failure.code, "SERVER");
  assert.equal(chunks[0].reason.failure.message, failure.reason.failure.message);
  assert.equal(failure.reason.failure.code, "PI_AI_ERROR");
});

test("repairs a Codex terminal failure while preserving earlier chunks", async () => {
  const harness = createHarness();
  const delta = { type: "text-delta", index: 0, text: "kept" };
  const failure = {
    type: "finish",
    reason: { kind: "error", failure: { code: "PI_AI_ERROR", message: "No response body" } },
  };
  const result = harness.listen({ provider: "openai-codex" }, () => (async function* () {
    yield delta;
    yield failure;
  })());
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(chunks[0], delta);
  assert.equal(chunks[1].reason.failure.code, "TRANSPORT");
  assert.equal(chunks[1].reason.failure.message, "No response body");
  assert.equal(failure.reason.failure.code, "PI_AI_ERROR");
});

test("leaves unknown Codex failures unchanged by identity", async () => {
  const harness = createHarness();
  const failure = {
    type: "finish",
    reason: { kind: "error", failure: { code: "PI_AI_ERROR", message: "WebSocket closed 1008 policy" } },
  };
  const result = harness.listen({ provider: "openai-codex" }, () => (async function* () { yield failure; })());
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(chunks[0], failure);
});
