import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_GENERIC_WEBSOCKET_ERROR,
  CODEX_SERVER_OVERLOADED_ERROR,
  repairCodexRetryableError,
  repairRetryableError,
  withCodexRetryableErrorRepair,
} from "../lib/transport-errors.js";

const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";
const RETRYABLE_CLOSE_CODES = [
  [1000, "TRANSPORT"], [1001, "TRANSPORT"], [1006, "TRANSPORT"],
  [1011, "SERVER"], [1012, "TRANSPORT"], [1013, "SERVER"],
];
const RETRYABLE_MESSAGES = [
  [CODEX_GENERIC_WEBSOCKET_ERROR, "TRANSPORT"],
  ["No response body", "TRANSPORT"],
  [CODEX_SERVER_OVERLOADED_ERROR, "SERVER"],
  [OVERLOAD_MESSAGE, "SERVER"],
];

function failureChunk(message = CODEX_GENERIC_WEBSOCKET_ERROR, code = "PI_AI_ERROR") {
  return {
    type: "finish",
    reason: {
      kind: "error",
      failure: { message, code, requestId: "request-preserved" },
    },
    replayState: { provider: "state-preserved" },
  };
}

for (const [message, expectedCode] of RETRYABLE_MESSAGES) {
  test("repairs exact failure " + JSON.stringify(message) + " as " + expectedCode, () => {
    const chunk = failureChunk(message);
    chunk.reason.failure.providerRetryAfterMs = 1500;
    chunk.reason.failure.status = 503;
    Object.freeze(chunk.reason.failure);
    Object.freeze(chunk.reason);
    Object.freeze(chunk);

    const repaired = repairCodexRetryableError(chunk);
    assert.notEqual(repaired, chunk);
    assert.deepEqual(repaired, {
      ...chunk,
      reason: {
        ...chunk.reason,
        failure: { ...chunk.reason.failure, code: expectedCode },
      },
    });
    assert.equal(chunk.reason.failure.code, "PI_AI_ERROR");
  });
}

for (const [closeCode, expectedCode] of RETRYABLE_CLOSE_CODES) {
  test("repairs terminal WebSocket close " + closeCode + " and preserves metadata", () => {
    for (const suffix of ["", " close reason", " ", " close reason\ntry again"]) {
      const message = "WebSocket closed " + closeCode + suffix;
      const chunk = failureChunk(message);
      chunk.reason.failure.providerRetryAfterMs = 1500;
      chunk.reason.failure.status = 503;
      const repaired = repairCodexRetryableError(chunk);
      assert.equal(repaired.reason.failure.code, expectedCode);
      assert.equal(repaired.reason.failure.message, message);
      assert.equal(repaired.reason.failure.requestId, "request-preserved");
      assert.equal(repaired.reason.failure.providerRetryAfterMs, 1500);
      assert.equal(repaired.reason.failure.status, 503);
      assert.equal(repaired.replayState, chunk.replayState);
      assert.equal(chunk.reason.failure.code, "PI_AI_ERROR");
    }
  });
}

test("leaves non-exact text and existing classifications unchanged", () => {
  const messages = [
    "another pi-ai failure", "websocket error", "No response body.",
    "no response body", "No response body ", " No response body",
    "prefix No response body", "No response body\n",
    "Our servers are currently overloaded. Please try again later",
    OVERLOAD_MESSAGE + " ", " " + OVERLOAD_MESSAGE, OVERLOAD_MESSAGE + "\n",
    "Other error: " + OVERLOAD_MESSAGE, "server overloaded",
    CODEX_SERVER_OVERLOADED_ERROR.toLowerCase(),
  ];
  for (const message of messages) {
    const chunk = failureChunk(message);
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
  for (const code of ["SERVER", "TRANSPORT", "TIMEOUT", "ABORTED", "AUTH", "RATE_LIMIT", "UNKNOWN", "", null, undefined]) {
    const chunk = failureChunk("No response body");
    chunk.reason.failure.code = code;
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
});

test("does not broaden close-code matching", () => {
  const messages = ["WebSocket closed"];
  for (const code of [1002, 1003, 1007, 1008, 1009, 1010, 1014, 1015, 4001]) {
    messages.push("WebSocket closed " + code, "WebSocket closed " + code + " close reason");
  }
  for (const [code] of RETRYABLE_CLOSE_CODES) {
    messages.push(
      "WebSocket closed " + code + "0", "WebSocket closed " + code + ": reason",
      "WebSocket closed " + code + "\nreason", "websocket closed " + code,
      "prefix WebSocket closed " + code, "WebSocket closed " + code + "\treason",
      "WebSocket closed  " + code, " WebSocket closed " + code,
    );
  }
  for (const message of messages) {
    const chunk = failureChunk(message);
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
});

test("does not repair ambiguous provider, quota, or buffer-limit errors", () => {
  for (const message of [
    "exceeded request buffer limit while retrying upstream",
    "Codex error: exceeded request buffer limit while retrying upstream",
    "You have hit your ChatGPT usage limit.", "Unauthorized",
    "Codex error: server_error", "Codex error: Internal error",
    "Codex response failed", "An unknown error occurred", "Service unavailable",
  ]) {
    const chunk = failureChunk(message);
    chunk.reason.failure.status = 503;
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
});

test("ignores missing and non-string messages", () => {
  for (const message of [undefined, null, 1006, {}, ["No response body"]]) {
    const chunk = failureChunk();
    chunk.reason.failure.message = message;
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
});

test("ignores completion, cancellation, model output, and malformed chunks", () => {
  for (const kind of ["stop", "aborted", "max-tokens", "tool-calls"]) {
    const chunk = { type: "finish", reason: { kind, failure: { code: "PI_AI_ERROR", message: "No response body" } } };
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
  const delta = { type: "text-delta", index: 0, text: CODEX_SERVER_OVERLOADED_ERROR };
  assert.equal(repairCodexRetryableError(delta), delta);
  for (const chunk of [null, undefined, {}, { type: "finish" }, { type: "finish", reason: { kind: "error" } }]) {
    assert.equal(repairCodexRetryableError(chunk), chunk);
  }
});

test("wrapper preserves stream order, identities, and replay state", async () => {
  const delta = { type: "text-delta", index: 0, text: "preserved" };
  const failure = failureChunk("WebSocket closed 1006 close reason");
  async function* chunks() { yield delta; yield failure; }
  const result = [];
  for await (const chunk of withCodexRetryableErrorRepair(chunks())) result.push(chunk);
  assert.equal(result.length, 2);
  assert.equal(result[0], delta);
  assert.equal(result[1].reason.failure.code, "TRANSPORT");
  assert.equal(result[1].reason.failure.message, failure.reason.failure.message);
  assert.equal(result[1].replayState, failure.replayState);
  assert.equal(failure.reason.failure.code, "PI_AI_ERROR");
});

test("wrapper propagates upstream throws without retrying", async () => {
  const error = new Error("upstream failure");
  let attempts = 0;
  async function* chunks() { attempts += 1; throw error; }
  await assert.rejects(async () => {
    for await (const chunk of withCodexRetryableErrorRepair(chunks())) assert.fail(JSON.stringify(chunk));
  }, (caught) => caught === error);
  assert.equal(attempts, 1);
});

test("repairs plain-text overload failures for other providers", () => {
  for (const message of [
    "The engine is currently overloaded, please try again later",
    "Overloaded",
    "{\"error\":{\"type\":\"engine_overloaded_error\",\"message\":\"The engine is currently overloaded, please try again later\"}}",
    "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
    "server_busy",
    "The servers are currently busy",
    "The model is at capacity",
    "The provider is currently experiencing high demand",
  ]) {
    const chunk = failureChunk(message);
    const repaired = repairRetryableError(chunk, "moonshot");
    assert.equal(repaired.reason.failure.code, "SERVER");
    assert.equal(repaired.reason.failure.message, message);
    assert.equal(chunk.reason.failure.code, "PI_AI_ERROR");
  }
});

test("does not apply Codex-specific or unrelated rules to other providers", () => {
  for (const message of [
    "No response body",
    "WebSocket closed 1006",
    "Service unavailable",
    "Internal error",
    "You have hit your usage limit",
    "not an overload failure",
  ]) {
    const chunk = failureChunk(message);
    assert.equal(repairRetryableError(chunk, "moonshot"), chunk);
  }
});

test("keeps the Codex whitelist narrow instead of applying generic overload matching", () => {
  const chunk = failureChunk("server overloaded");
  assert.equal(repairRetryableError(chunk, "openai-codex"), chunk);
});

test("wrapper closes its source when the consumer stops early", async () => {
  const delta = { type: "text-delta", index: 0, text: "preserved" };
  let reads = 0;
  let finalized = 0;
  async function* chunks() {
    try {
      reads += 1;
      yield delta;
      reads += 1;
      yield failureChunk("No response body");
    } finally { finalized += 1; }
  }
  const iterator = withCodexRetryableErrorRepair(chunks());
  assert.equal((await iterator.next()).value, delta);
  await iterator.return();
  assert.equal(reads, 1);
  assert.equal(finalized, 1);
});
