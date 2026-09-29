/**
 * The game's health snapshot (`world.getHealth`) and the plumbing that tells the
 * client when it changes.
 *
 * The evidence lives elsewhere (llmHealth.ts, tickHealth.ts, the planning
 * breaker, conversationPacing); this file only joins it and, more importantly,
 * decides WHEN to speak. The client refetches on the `world.health` channel, so
 * the channel is marked dirty only when the snapshot's SIGNATURE moves (a
 * different verdict, reason, breaker or lag state), never per tick or per LLM
 * call: a busy town makes hundreds of calls a minute and a chatty channel would
 * refetch the snapshot for nothing.
 */
import { llmHealth, evaluateLLMHealth, evaluateEmbeddingHealth, type LLMStatus } from '../ai/llmHealth';
import { tickHealth, type TickHealthSnapshot } from '../engine/tickHealth';
import { emitter } from '../engine/emitter';
import { planLLMGate } from './planning/instance';
import { conversationsOnTemplates } from './conversationPacing';
import { gameMinutesNow } from './worldClock';
import { db } from '../db';
import { worldState } from '../db/schema';
import { nightSkip } from '../engine/nightSkip';

export const HEALTH_CHANNEL = 'world.health';

export interface HealthSnapshot {
  llm: { status: LLMStatus; reason: string | null };
  /** The planning circuit breaker is open: planning is refused town-wide. */
  breakerOpen: boolean;
  embeddings: { ok: boolean; reason: string | null };
  tick: TickHealthSnapshot;
}

function currentSpeed(): number {
  try {
    return db.select({ s: worldState.tick_speed }).from(worldState).limit(1).get()?.s ?? 1;
  } catch {
    return 1; // no tables yet (fresh DB, setup wizard)
  }
}

export function getHealthSnapshot(): HealthSnapshot {
  const onTemplates = (() => {
    // Judged at the speed the player chose: a night skip runs at 30x, where every
    // measured turn is "too slow", and that is the skip's doing, not the model's.
    try { return conversationsOnTemplates(gameMinutesNow(), nightSkip.restoreSpeed() ?? currentSpeed()); } catch { return false; }
  })();
  const breakerOpen = planLLMGate.breakerOpen;
  const verdict = evaluateLLMHealth({ ...llmHealth.evidence(), breakerOpen, conversationsOnTemplates: onTemplates });
  const emb = evaluateEmbeddingHealth(llmHealth.embeddingEvidence());
  return { llm: verdict, breakerOpen, embeddings: emb, tick: tickHealth.snapshot() };
}

/** What the client would render differently; excludes the raw numbers that jitter. */
export function healthSignature(h: HealthSnapshot): string {
  return [h.llm.status, h.llm.reason, h.breakerOpen, h.embeddings.ok, h.embeddings.reason, h.tick.lagging].join('|');
}

// Starts as the all-clear signature: a healthy start announces nothing.
let lastSignature = "ok|null|false|true|null|false";

function getHealthSnapshotSafe(): HealthSnapshot {
  try { return getHealthSnapshot(); } catch {
    return { llm: { status: 'ok', reason: null }, breakerOpen: false, embeddings: { ok: true, reason: null }, tick: { lastTickOverrunMs: 0, slowTicksLastMinute: 0, lagging: false } };
  }
}

/**
 * Re-derive the snapshot and tell subscribers if it changed. Cheap enough to
 * call after every LLM call and every slow tick.
 */
export function refreshHealth(): boolean {
  const sig = healthSignature(getHealthSnapshotSafe());
  if (sig === lastSignature) return false;
  lastSignature = sig;
  emitter.markDirty(HEALTH_CHANNEL);
  emitter.flushChannel(HEALTH_CHANNEL);
  return true;
}

let watching = false;
const WATCH_INTERVAL_MS = 5_000;

/**
 * Wire the evidence sources to `refreshHealth` and start a slow re-check.
 * The timer covers verdicts that change by the clock alone (a slow-tick minute
 * ending, evidence ageing out while the game is paused). Idempotent.
 */
export function startHealthWatch(): void {
  if (watching) return;
  watching = true;
  llmHealth.onChange(refreshHealth);
  planLLMGate.onBreakerChange(refreshHealth);
  setInterval(refreshHealth, WATCH_INTERVAL_MS).unref();
}
