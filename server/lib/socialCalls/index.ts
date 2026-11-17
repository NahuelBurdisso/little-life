/**
 * Social calls (see ./engine.ts for the why): the public API and the wiring.
 *
 * Side-effect module, like giftEngine and milestonesEngine: importing it
 * registers the built-in kinds (kinds.ts) and one simEvents listener per event
 * it reacts to (server/index.ts and engine/tick.ts import it). Listeners run
 * inside the emitting phase's transaction (except the tavern and loneliness
 * passes, which emit outside one), so each only SCHEDULES calls — cheap reads,
 * a few in-memory writes — and never throws into the emitter.
 *
 * The visit itself is read back on `conversation:ended`: the caller's own emit
 * of a conversation queued with `trigger_reason: 'social_call:<kind>'` (both
 * tiers carry `triggerReason`) runs the kind's consequence once.
 */
import { simEvents, type SimEventPayloads } from '../simEvents';
import { gameMinutesNow } from '../worldClock';
import {
  allPendingCalls, callOf, clearSocialCalls, dropCallsInvolving, finishCall, runDueWatches, socialCallKind, startLinger,
} from './engine';
import { clearProducerState, defaultJudge, producers, registerBuiltInKinds } from './kinds';
import { loansHourly, onHardTimes } from './loans';
import { callKindOfTrigger } from './topics';
import { clearReciprocity, noteOrdeal, reciprocityHourly } from './reciprocity';

export {
  scheduleCall, pendingCallsFor, callsMadeTo, callOf, registerSocialCallKind, socialCallsSnapshotStore,
} from './engine';
export { SOCIAL_CALL_KINDS } from './kinds';
export type { SocialCall, SocialCallKind, CallRecord, VisitResult } from './types';
export { noteOrdeal, reciprocityTally } from './reciprocity';

registerBuiltInKinds();

/** Forget every call, record and producer tally (a world replace; worldCaches.ts). */
export function clearSocialCallState(): void {
  clearSocialCalls();
  clearProducerState();
  clearReciprocity();
}

interface EndedPayload {
  agentId: number;
  perpetratorId?: number | null;
  triggerReason?: string;
  template?: boolean;
  sentiment?: number;
  turns?: number;
}

/**
 * The visit's conversation ended. Handled once, on the caller's own emit (the
 * caller opened it: participants[0]). An LLM chat that ended with no line said
 * (a failed first turn) is not a visit: the call stays pending and they try again.
 */
export function onCallConversationEnded(p: EndedPayload): void {
  const kind = callKindOfTrigger(p.triggerReason);
  if (!kind || p.perpetratorId == null) return;  const call = callOf(p.agentId);
  if (!call || call.kind !== kind || call.targetId !== p.perpetratorId) return;
  const template = p.template === true;
  if (!template && (p.turns ?? 0) === 0) return;
  const def = socialCallKind(kind);
  if (!def) return;
  const nowMin = gameMinutesNow();
  const chat = { template, sentiment: p.sentiment ?? 0 };
  const good = (def.judge ?? defaultJudge)(call, chat);
  // Recorded before the consequence runs, so a consequence that reads "who came"
  // (the forgotten-birthday check, the vigil's grief) counts this visit.
  finishCall(call.id, 'made', nowMin, good);
  def.consequence(call, { good, template, sentiment: chat.sentiment, nowMin });
  if (good && def.lingerMin) startLinger(call.callerId, call.targetId, nowMin + def.lingerMin, call.id);
}

/**
 * Hourly (engine/tick.ts, in a transaction): calls whose caller was never free
 * to be decided past their window are recorded missed, due watches run (the
 * birthday nobody remembered), loans are repaid or sour.
 */
export function socialCallsHourly(nowMin: number): void {
  for (const c of allPendingCalls()) {
    if (nowMin > c.expiresAtMin) finishCall(c.id, 'expired', nowMin);
  }
  runDueWatches(nowMin);
  loansHourly(nowMin);
  reciprocityHourly(nowMin);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/** A listener never takes the emitting phase down with it. */
function guarded<T>(name: string, fn: (p: T) => void): (p: T) => void {
  return (p: T) => {
    try {
      fn(p);
    } catch (err) {
      console.warn(`[socialCalls] ${name} failed:`, (err as Error).message);
    }
  };
}

let initialized = false;

function initSocialCalls(): void {
  if (initialized) return;
  initialized = true;

  simEvents.on('conversation:ended', guarded<EndedPayload>('conversation:ended', onCallConversationEnded));

  simEvents.on('state:triggered', guarded<{ agentId: number; state: string; cause?: string }>('state:triggered', (p) => {
    const now = gameMinutesNow();
    switch (p.state) {
      case 'sick':
        if (producers.onSick(p.agentId, now)) noteOrdeal(p.agentId, 'sick', now);
        break;
      case 'heartbroken': producers.onHeartbroken(p.agentId, now); break;
      case 'in_debt':
        onHardTimes(p.agentId, now);
        noteOrdeal(p.agentId, 'in_debt', now);
        break;
      case 'grieving':
        // Only a death's mourners (lifeEventsEngine.ts): "mourning <name>".
        if (typeof p.cause === 'string' && p.cause.startsWith('mourning ')) {
          producers.onMourning(p.agentId, p.cause.slice('mourning '.length), now);
          noteOrdeal(p.agentId, 'grieving', now);
        }
        break;
    }
  }));
  simEvents.on('economy:distress', guarded<{ agentId: number }>('economy:distress', (p) => onHardTimes(p.agentId, gameMinutesNow())));
  simEvents.on('health:grave', guarded<SimEventPayloads['health:grave']>('health:grave', (p) => producers.onGrave(p.agentId, gameMinutesNow())));
  simEvents.on('agent:birthday', guarded<{ agentId: number }>('agent:birthday', (p) => producers.onBirthday(p.agentId, gameMinutesNow())));
  simEvents.on('life:arrived', guarded<{ agentId: number }>('life:arrived', (p) => producers.onArrived(p.agentId, gameMinutesNow())));
  simEvents.on('family:birth', guarded<SimEventPayloads['family:birth']>('family:birth', (p) => producers.onBirth(p.parentIds, p.childName, gameMinutesNow())));
  simEvents.on('life:engaged', guarded<SimEventPayloads['life:engaged']>('life:engaged', (p) => producers.onEngaged(p.proposerId, p.answererId, gameMinutesNow())));
  simEvents.on('civic:election', guarded<SimEventPayloads['civic:election']>('civic:election', (p) => producers.onElection(p.winnerId, p.loserIds, gameMinutesNow())));
  simEvents.on('life:job_changed', guarded<{ agentId: number; from: string; to: string; reason: string }>('life:job_changed',
    (p) => producers.onJobChanged(p.agentId, p.from, p.to, p.reason, gameMinutesNow())));
  simEvents.on('life:thinking_of_leaving', guarded<SimEventPayloads['life:thinking_of_leaving']>('life:thinking_of_leaving',
    (p) => producers.onThinkingOfLeaving(p.agentId, gameMinutesNow())));
  simEvents.on('life:decided_to_stay', guarded<SimEventPayloads['life:decided_to_stay']>('life:decided_to_stay',
    (p) => producers.onDecidedToStay(p.agentId, gameMinutesNow())));
  simEvents.on('crime:released', guarded<SimEventPayloads['crime:released']>('crime:released', (p) => producers.onReleased(p.agentId, gameMinutesNow())));
  // The dead and the departed keep no promises and receive no visitors. The
  // vigil's grief and guilt are read first, while the pending calls still say
  // who was on their way.
  simEvents.on('life:death', guarded<{ agentId: number }>('life:death', (p) => {
    const now = gameMinutesNow();
    producers.onDeathAfterVigil(p.agentId, now);
    dropCallsInvolving(p.agentId, now);
  }));
  simEvents.on('life:departed', guarded<{ agentId: number; name: string }>('life:departed', (p) => {
    const now = gameMinutesNow();
    producers.onLeftTown(p.agentId, p.name, now);
    dropCallsInvolving(p.agentId, now);
  }));
}

initSocialCalls();
