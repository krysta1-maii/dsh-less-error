/**
 * Narrow pi-ai retryable-error repairs extracted from dsh-llm-pi-ai-oauth.
 *
 * pi-ai emits provider-specific failure text that dsh-llm-pi-ai can
 * conservatively leave as `PI_AI_ERROR`. Only failures whose provider-neutral
 * retry class is explicit are repaired. The host's dsh-llm-retry plugin remains
 * responsible for retry limits, backoff, cancellation, and durable events.
 */

export const CODEX_GENERIC_WEBSOCKET_ERROR = "WebSocket error";
const CODEX_SERVER_OVERLOADED_MESSAGE = "Our servers are currently overloaded. Please try again later.";
export const CODEX_SERVER_OVERLOADED_ERROR = `Codex error: ${CODEX_SERVER_OVERLOADED_MESSAGE}`;

// Match pi-ai's exact close-message format, not arbitrary mentions of close codes.
// Close 1000 reaches this error-only path only when pi-ai saw no completion.
const CODEX_WEBSOCKET_TRANSPORT_CLOSE = /^WebSocket closed (?:1000|1001|1006|1012)(?: [\s\S]*)?$/;
const CODEX_WEBSOCKET_SERVER_CLOSE = /^WebSocket closed (?:1011|1013)(?: [\s\S]*)?$/;

const RETRYABLE_PI_AI_FAILURES = new Map([
  [CODEX_GENERIC_WEBSOCKET_ERROR, "TRANSPORT"],
  ["No response body", "TRANSPORT"],
  [CODEX_SERVER_OVERLOADED_ERROR, "SERVER"],
  [CODEX_SERVER_OVERLOADED_MESSAGE, "SERVER"],
]);

function retryableWebSocketCloseCode(message) {
  if (typeof message !== "string") return undefined;
  if (CODEX_WEBSOCKET_TRANSPORT_CLOSE.test(message)) return "TRANSPORT";
  if (CODEX_WEBSOCKET_SERVER_CLOSE.test(message)) return "SERVER";
  return undefined;
}

// Other pi-ai providers (Kimi/Moonshot, Anthropic, gateways, ...) can report
// overload as plain text or as a JSON error type, without an HTTP status in the
// flattened message. These phrases are also in pi-ai's own retryable matcher.
const PROVIDER_OVERLOAD_MESSAGE = /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity/i;

function repairedCodeFor(failure, provider) {
  if (failure?.code !== "PI_AI_ERROR") return undefined;
  if (provider === "openai-codex") {
    return RETRYABLE_PI_AI_FAILURES.get(failure.message)
      ?? retryableWebSocketCloseCode(failure.message);
  }
  if (typeof failure.message === "string" && PROVIDER_OVERLOAD_MESSAGE.test(failure.message)) {
    return "SERVER";
  }
  return undefined;
}

/**
 * Repair one terminal chunk containing a known retryable pi-ai
 * misclassification. Every other chunk and failure is returned by identity.
 *
 * @param {unknown} chunk
 * @param {string} provider
 * @returns {unknown}
 */
export function repairRetryableError(chunk, provider) {
  const failure = chunk?.type === "finish" && chunk.reason?.kind === "error"
    ? chunk.reason.failure
    : undefined;
  const repairedCode = repairedCodeFor(failure, provider);

  if (repairedCode === undefined) return chunk;

  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...failure,
        code: repairedCode,
      },
    },
  };
}

/** Backward-compatible Codex-only single-chunk repair. */
export function repairCodexRetryableError(chunk) {
  return repairRetryableError(chunk, "openai-codex");
}

/** Apply the repairs without changing stream order, cancellation, or cleanup. */
export async function* withRetryableErrorRepair(chunks, provider) {
  for await (const chunk of chunks) {
    yield repairRetryableError(chunk, provider);
  }
}

/** Backward-compatible Codex-only stream wrapper. */
export async function* withCodexRetryableErrorRepair(chunks) {
  yield* withRetryableErrorRepair(chunks, "openai-codex");
}
