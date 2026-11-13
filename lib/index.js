/**
 * dsh-less-error: repair selected Codex transport failures at the public
 * llm/stream seam. The same seam covers direct and prepared LLM calls.
 */
import { withRetryableErrorRepair } from "./transport-errors.js";

export const name = "less-error";
export const inject = ["llm"];

export function apply(ctx) {
  ctx.on("llm/stream", (options, next) => {
    return withRetryableErrorRepair(next(), options.provider);
  });
}
