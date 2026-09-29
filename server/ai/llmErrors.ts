/**
 * The LLM answered, but with no usable content: an empty message, or only
 * reasoning (Ollama `thinking`, OpenAI-compatible `reasoning_content`).
 *
 * Distinct from a transport failure (timeout, refused connection, HTTP error)
 * because callers weigh them differently: the planner's outage breaker must
 * only count the LLM being unreachable, while an empty answer means it is up
 * and this particular request should just back off. Lives in its own module so
 * tests that mock `ollama.ts` wholesale still get the real class.
 */
export class LLMEmptyReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMEmptyReplyError';
  }
}
