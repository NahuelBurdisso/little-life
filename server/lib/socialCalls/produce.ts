/**
 * The one way a producer turns "something happened to X" into calls: gather who
 * X's people are, pick the ones who will bother, stagger them, schedule.
 *
 * The dice are this module's own, seeded per event (world seed + kind + target
 * + minute): producers run inside other phases' listeners, and a Math.random()
 * draw here would shift the draw order those phases' tests sequence. Seeding
 * also makes a soak replay the same visitors for the same events.
 */
import { makeRng, stringToSeed } from '../worldgen/rng';
import { currentWorldSeed } from '../intimacy/worldSeed';
import { callsMadeTo, pendingCallsFor, scheduleCall, socialCallKind } from './engine';
import { RETURN_MIN, pickCallers, staggerOffsets, type CallerCandidate, type PickSpec } from './pickCallers';
import { gatherCandidates } from './ties';
import type { CallPayload, SocialCall } from './types';

let rngOverride: (() => number) | null = null;

/**
 * Tests only: every decision of the system draws from `fn` instead of its seeded
 * source (null restores it), so a test can say "the friend comes" or "nobody does".
 */
export function setSocialCallRng(fn: (() => number) | null): void {
  rngOverride = fn;
}

/** A seeded uniform [0, 1) source for one decision. */
export function rngFor(key: string): () => number {
  if (rngOverride) return rngOverride;
  const r = makeRng(stringToSeed(`${String(currentWorldSeed())}|calls|${key}`));
  return () => r.next();
}

export interface ProduceRequest {
  kind: string;
  targetId: number;
  nowMin: number;
  spec: PickSpec;
  /** Game minutes: the first caller after `first`, the next `spacing` later, each with up to `jitter` of slack. */
  stagger: { first: number; spacing: number; jitter: number };
  payload?: CallPayload;
  /** Nobody new comes if a call of this kind was made to the target within this many game minutes. */
  targetCooldownMin?: number;
  /** Only these candidates (a loan needs a full purse and a warm heart). */
  filter?: (c: CallerCandidate) => boolean;
  /** An absolute end for every call (a birthday ends at night), instead of the kind's window. */
  expiresAtMin?: number;
}

/** Schedule the callers this event brings; returns the calls made (often none). */
export function produceCalls(req: ProduceRequest): SocialCall[] {
  const def = socialCallKind(req.kind);
  if (!def) return [];
  if (req.targetCooldownMin != null && callsMadeTo(req.targetId, req.kind, req.nowMin - req.targetCooldownMin).length > 0) return [];
  const room = def.maxPendingPerTarget - pendingCallsFor(req.targetId, req.kind).length;
  if (room <= 0) return [];
  const cands = gatherCandidates(req.targetId).filter((c) => !req.filter || req.filter(c));
  const rng = rngFor(`${req.kind}|${req.targetId}|${req.nowMin}`);
  const chosen = pickCallers(cands, { ...req.spec, max: Math.min(req.spec.max, room) }, rng);
  const offsets = staggerOffsets(chosen.length, req.stagger.first, req.stagger.spacing, req.stagger.jitter, rng);
  const out: SocialCall[] = [];
  const owesOf = new Map(cands.map((c) => [c.id, c.owes ?? 0]));
  chosen.forEach((callerId, i) => {
    const notBeforeMin = req.nowMin + offsets[i];
    // A caller who owes the target a kindness is returning it: the visit's
    // consequence and feed row say so (effects.ts `feed`, kinds.ts `warmVisit`).
    const returning = (owesOf.get(callerId) ?? 0) >= RETURN_MIN;
    const call = scheduleCall({
      kind: req.kind, callerId, targetId: req.targetId, nowMin: req.nowMin, notBeforeMin,
      ...(req.expiresAtMin != null ? { expiresAtMin: Math.max(req.expiresAtMin, notBeforeMin + 60) } : {}),
      payload: returning ? { ...(req.payload ?? {}), returning: true } : req.payload,
    });
    if (call) out.push(call);
  });
  return out;
}
