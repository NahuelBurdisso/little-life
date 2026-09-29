/**
 * Is the LLM behind the town working? The one place that answers, for the
 * in-game health banner (`world.getHealth`).
 *
 * Why this exists: an Ollama that is down, missing its model, or just slow
 * never showed up in the game. The townsfolk quietly fell back to template
 * chats and routine plans, and the player only saw a town that felt dead. The
 * evidence was all there (failed calls in `llmMetrics`, the planning breaker in
 * `PlanLLMGate`, the "model not installed" line in `warmup.ts`), just scattered
 * across the console.
 *
 * Two halves, so the rules can be tested without a clock or a model:
 *   - `evaluateLLMHealth`  pure: evidence in, verdict out.
 *   - `LLMHealthTracker`   remembers the evidence (recent call outcomes, a
 *                          missing model) and fires `onChange` when it moves.
 *
 * Deliberately not part of llmMetrics.ts: that file is per-purpose latency
 * statistics for tuning, cumulative since start. A verdict needs the RECENT
 * window and ages out, or a Ollama that came back ten minutes ago would still
 * read as down.
 */

export type LLMStatus = 'ok' | 'degraded' | 'down';

export interface LLMVerdict {
  status: LLMStatus;
  /** Short player-facing cause, or null when everything is fine. */
  reason: string | null;
}

/** Consecutive failed chat calls (no success in between) that mean "down". */
export const DOWN_AFTER_FAILURES = 3;

/**
 * Recent chat calls looked at for the failure rate, and how many must have
 * happened before a rate means anything (two calls failing out of three at
 * startup is not a trend).
 */
export const RATE_WINDOW = 20;
export const RATE_MIN_CALLS = 8;
/** Share of the window that failing marks the LLM degraded. */
export const DEGRADED_FAILURE_RATE = 0.25;

/**
 * Evidence older than this is ignored. Nothing calls the LLM while the game is
 * paused, so without an expiry a failure streak from before the pause would
 * keep the banner up after Ollama was restarted.
 */
export const EVIDENCE_MAX_AGE_MS = 10 * 60_000;

export interface CallOutcome {
  ok: boolean;
  atMs: number;
  /** Set on failures. */
  error?: string;
}

export interface HealthEvidence {
  nowMs: number;
  /** Newest last. */
  chatCalls: CallOutcome[];
  /** Model the server was told to use and Ollama does not have, or null. */
  missingChatModel: string | null;
  /** The planning circuit breaker (PlanLLMGate) is open: three failures in a row town-wide. */
  breakerOpen: boolean;
  /** Ordinary conversations are being demoted to template lines because turns are too slow at this speed. */
  conversationsOnTemplates: boolean;
}

/**
 * Turn a raw error message into something a player can act on. Node's `fetch`
 * says only "fetch failed" for a refused connection, and the real code hides in
 * `cause`; the timeout message is ours (ollama.ts).
 */
export function describeLLMError(message: string | undefined): string {
  const m = (message ?? '').trim();
  if (!m) return 'no answer from the model';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|connect/i.test(m)) return 'cannot reach Ollama - is it running?';
  if (/timed out/i.test(m)) return 'the model is not answering in time';
  if (/model .*not found|try pulling|not installed/i.test(m)) return 'the model is not installed';
  if (/\(5\d\d\)|\b5\d\d\b/.test(m)) return 'the LLM server is returning errors';
  return m.length > 80 ? `${m.slice(0, 77)}...` : m;
}

/** Was this failure Ollama saying it does not have the model? */
export function isMissingModelError(message: string | undefined): boolean {
  return /model .*not found|try pulling|not installed/i.test(message ?? '');
}

/** Failures since the last success, newest first, within the evidence window. */
function freshCalls(e: HealthEvidence): CallOutcome[] {
  return e.chatCalls.filter((c) => e.nowMs - c.atMs <= EVIDENCE_MAX_AGE_MS);
}

/**
 * The verdict.
 *
 * down      the model is missing, or the planning breaker is open, or the last
 *           DOWN_AFTER_FAILURES calls all failed. Conversations and plans are
 *           on their fallbacks.
 * degraded  a real share of recent calls fail, or the town's conversations
 *           have been demoted to template lines because turns are too slow.
 * ok        otherwise, including "no evidence yet".
 */
export function evaluateLLMHealth(e: HealthEvidence): LLMVerdict {
  if (e.missingChatModel) {
    return { status: 'down', reason: `model "${e.missingChatModel}" is not installed in Ollama (ollama pull ${e.missingChatModel})` };
  }

  const calls = freshCalls(e);
  let streak = 0;
  for (let i = calls.length - 1; i >= 0 && !calls[i].ok; i--) streak++;
  const lastError = streak > 0 ? calls[calls.length - 1].error : undefined;

  if (streak >= DOWN_AFTER_FAILURES) return { status: 'down', reason: describeLLMError(lastError) };

  // The breaker is the planning layer's own verdict on the same question and
  // can stay open after the chat window aged out (it only probes once a minute).
  if (e.breakerOpen) return { status: 'down', reason: describeLLMError(lastError ?? 'timed out') };

  const window = calls.slice(-RATE_WINDOW);
  if (window.length >= RATE_MIN_CALLS) {
    const failed = window.filter((c) => !c.ok).length;
    if (failed / window.length >= DEGRADED_FAILURE_RATE) {
      const lastFail = [...window].reverse().find((c) => !c.ok);
      return { status: 'degraded', reason: describeLLMError(lastFail?.error) };
    }
  }

  if (e.conversationsOnTemplates) return { status: 'degraded', reason: 'turns are too slow for live conversations at this speed' };

  return { status: 'ok', reason: null };
}

export interface EmbeddingVerdict {
  ok: boolean;
  reason: string | null;
}

/** Embedding failures in a row that mean memory search is off. */
export const EMBED_DOWN_AFTER_FAILURES = 3;

export function evaluateEmbeddingHealth(e: {
  nowMs: number;
  calls: CallOutcome[];
  missingModel: string | null;
}): EmbeddingVerdict {
  if (e.missingModel) {
    return { ok: false, reason: `embedding model "${e.missingModel}" is not installed (ollama pull ${e.missingModel})` };
  }
  const calls = e.calls.filter((c) => e.nowMs - c.atMs <= EVIDENCE_MAX_AGE_MS);
  let streak = 0;
  for (let i = calls.length - 1; i >= 0 && !calls[i].ok; i--) streak++;
  if (streak >= EMBED_DOWN_AFTER_FAILURES) {
    return { ok: false, reason: describeLLMError(calls[calls.length - 1].error) };
  }
  return { ok: true, reason: null };
}

/** Outcomes kept per pool; comfortably more than either window reads. */
const KEEP = 40;

/**
 * Remembers what the LLM has been doing lately. `note*` are called from the
 * places that see the outcomes (ollama.ts, warmup.ts); `snapshot` is what the
 * health service reads. `onChange` fires after every note so the service can
 * re-derive the verdict and tell the client only if it moved.
 */
export class LLMHealthTracker {
  private chat: CallOutcome[] = [];
  private embed: CallOutcome[] = [];
  private missingChat: string | null = null;
  private missingEmbed: string | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private fire(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* a health listener must never break an LLM call */ }
    }
  }

  private push(list: CallOutcome[], outcome: CallOutcome): void {
    list.push(outcome);
    if (list.length > KEEP) list.shift();
  }

  /** One finished chat call (cancelled ones are not reported: they say nothing about the model). */
  noteChat(ok: boolean, model: string, error?: string): void {
    this.push(this.chat, { ok, atMs: this.clock(), error });
    if (ok) this.missingChat = null;
    else if (isMissingModelError(error)) this.missingChat = model;
    this.fire();
  }

  noteEmbedding(ok: boolean, model: string, error?: string): void {
    this.push(this.embed, { ok, atMs: this.clock(), error });
    if (ok) this.missingEmbed = null;
    else if (isMissingModelError(error)) this.missingEmbed = model;
    this.fire();
  }

  /** Warm-up found Ollama without a model. Cleared by the first successful call of that kind. */
  noteModelMissing(kind: 'chat' | 'embedding', model: string): void {
    if (kind === 'chat') this.missingChat = model;
    else this.missingEmbed = model;
    this.fire();
  }

  evidence(): Omit<HealthEvidence, 'breakerOpen' | 'conversationsOnTemplates'> {
    return { nowMs: this.clock(), chatCalls: this.chat, missingChatModel: this.missingChat };
  }

  embeddingEvidence(): { nowMs: number; calls: CallOutcome[]; missingModel: string | null } {
    return { nowMs: this.clock(), calls: this.embed, missingModel: this.missingEmbed };
  }

  /** Forget everything (tests). */
  reset(): void {
    this.chat = [];
    this.embed = [];
    this.missingChat = null;
    this.missingEmbed = null;
  }
}

export const llmHealth = new LLMHealthTracker();
