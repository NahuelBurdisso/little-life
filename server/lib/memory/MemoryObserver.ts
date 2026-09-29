import { simEvents } from '../simEvents';
import { describeEvent } from './descriptionTemplates';
import { pickConversationGist, type GistLine } from './conversationGist';
import type { MemoryService } from './MemoryService';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { gameMinutesNow } from '../worldClock';
import { CONFIG } from '../constants';
import { summarizeConversation, summaryPriority, type SummaryLine } from './conversationSummary';
import { isAnyWatched } from '../spotlight';
import { isFallbackMessage } from '../../ai/sanitizeDialogue';
import { getImportance } from './ImportanceScorer';
import { goalClause } from '../goalText';
import { itemPhrase, itemCountPhrase } from '../../data/economyData';
import { endSentence } from '../factText';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';

/** One summary call per conversation, shared by its participants' handlers. */
const pendingSummaries = new Map<number, Promise<Map<string, string> | null>>();

/**
 * Game minutes before the same perception line may be stored again for the
 * same agent. Perception fires every time two agents are near each other, and
 * a playtest stored "I noticed Diego Santos nearby and struck up a
 * conversation." 71 times — 867 of 1055 new memories were observations. The
 * copies drown retrieval (every query about Diego returns the same line),
 * trip the reflection trigger on repetition alone, and fill reflection prompts.
 */
export const PERCEPTION_REPEAT_MINUTES = 180;

const lastPerceived = new Map<string, number>();

/** Whether this perception line should be stored now (and remember it if so). */
export function shouldRecordPerception(agentId: number, description: string, nowMinutes: number): boolean {
  const key = `${agentId}|${description}`;
  const last = lastPerceived.get(key);
  if (last != null && nowMinutes - last >= 0 && nowMinutes - last < PERCEPTION_REPEAT_MINUTES) return false;
  lastPerceived.set(key, nowMinutes);
  if (lastPerceived.size > 5000) {
    for (const [k, t] of lastPerceived) if (nowMinutes - t >= PERCEPTION_REPEAT_MINUTES) lastPerceived.delete(k);
  }
  return true;
}

export function clearPerceptionDedup(): void {
  lastPerceived.clear();
  pendingSummaries.clear();
}

export function initMemoryObserver(memoryService: MemoryService): void {
  // Movement. These events never fired before B21 (movement.ts compared the
  // destination with itself), so this is the first time they reach memory, and
  // every walk that changes place is one of each: a dozen or more a day per
  // agent, each costing an embedding and feeding the reflection trigger. So:
  // only the arrival is stored (it says where the agent went; the departure
  // only repeats the previous arrival), at the importance ImportanceScorer
  // gives `moved_to_location`, and once per place per perception window — back
  // and forth to the same shop is one trip worth remembering, not four.
  simEvents.on('agent:arrived', ({ agentId, locationName }: { agentId: number; locationName: string }) => {
    if (!shouldRecordPerception(agentId, `arrival|${locationName}`, gameMinutesNow())) return;
    const description = describeEvent('arrival', { location: locationName });
    memoryService.record(agentId, 'observation', description, { subtype: 'movement' }, 0, getImportance('moved_to_location'));
  });

  simEvents.on('conversation:started', ({ agentId, otherName }: { agentId: number; otherName: string }) => {
    const description = describeEvent('conversation_start', { other: otherName });
    memoryService.record(agentId, 'observation', description, { subtype: 'conversation' });
  });

  simEvents.on(
    'conversation:ended',
    ({
      agentId,
      conversationId,
      otherName,
      summary,
      turns,
      sentiment,
      truncated,
      messages,
    }: {
      agentId: number;
      conversationId?: number;
      otherName: string;
      summary: string;
      turns: number;
      sentiment: number;
      truncated?: boolean;
      messages?: GistLine[];
    }) => {
      const names = new Map<number, string | undefined>();
      const nameOf = (id: number) => {
        if (!names.has(id)) {
          names.set(id, db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name);
        }
        return names.get(id);
      };

      // LLM conversations long enough to have content: remember each side's
      // own takeaway (one shared LLM call). A cut-short one keeps the gist and
      // its "we got cut off" wording.
      const spoken: SummaryLine[] = (messages ?? [])
        .filter((m) => !isFallbackMessage(m, nameOf(m.speakerId) ?? ''))
        .map((m) => ({ speaker: nameOf(m.speakerId) ?? 'Someone', text: m.text }));
      const me = nameOf(agentId);
      // Short off-screen chats keep the gist; see summaryPriority. Every
      // participant's handler runs in this same emit loop and reads the same
      // spotlight, so they agree on whether the shared summary call happens.
      const speakers = [agentId, ...(messages ?? []).map((m) => m.speakerId)];
      const priority = summaryPriority(spoken.length, isAnyWatched(speakers));
      if (CONFIG.AI.CONVERSATION_SUMMARIES && conversationId != null && !truncated && me && priority) {
        const worldEpoch = currentWorldEpoch();
        let pending = pendingSummaries.get(conversationId);
        if (!pending) {
          const participants = [...new Set(spoken.map((l) => l.speaker))];
          pending = summarizeConversation(participants, spoken, priority);
          pendingSummaries.set(conversationId, pending);
          // Every participant's handler runs in this same emit loop, so the
          // entry is only needed until the call settles.
          void pending.finally(() => pendingSummaries.delete(conversationId));
        }
        pending.then((takeaways) => {
          const takeaway = takeaways?.get(me);
          // The world may have been replaced while the model answered, and
          // SQLite reuses ids. A name check alone missed it whenever the new
          // world kept the default cast (same names, same ids): the epoch is
          // what tells the worlds apart.
          if (isStaleWorldEpoch(worldEpoch)) return;
          const current = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get()?.name;
          if (current !== me) return;
          if (!takeaway) {
            recordGist();
            return;
          }
          memoryService.record(
            agentId,
            'conversation',
            describeEvent('conversation_takeaway', { other: otherName, takeaway }),
            { subtype: 'conversation', summary, turns, takeaway: true },
            sentiment,
          );
        }).catch((err) => {
          // Runs detached from the tick: an escaping throw would be an
          // unhandled rejection and take the server down.
          console.warn('[MemoryObserver] conversation takeaway failed:', err);
        });
        return;
      }
      recordGist();

      function recordGist(): void {
      // Remember something that was actually said, not just the topic label.
      // Only LLM conversations pass their transcript; template ones (and any
      // transcript with nothing worth quoting) keep the topic templates.
      const gist = messages?.length ? pickConversationGist(messages, nameOf) : null;
      let description: string;
      if (gist) {
        const who = gist.speakerId === agentId ? 'I' : 'they';
        // In a group chat the quote belongs to one of several people.
        const quotedName = who === 'they' && otherName.includes(' and ')
          ? nameOf(gist.speakerId) ?? otherName
          : otherName;
        description = describeEvent(truncated ? 'conversation_cut_short_quote' : 'conversation_end_quote', {
          other: quotedName,
          quote: gist.quote,
          who,
        });
      } else {
        // A conversation the turn budget force-ended must not be remembered as one
        // that "wrapped up" — the agent would later reason about it as finished
        // business. Template conversations never set the flag.
        description = describeEvent(truncated ? 'conversation_cut_short' : 'conversation_end', {
          other: otherName,
          summary,
          turns,
        });
      }
      memoryService.record(
        agentId,
        'conversation',
        description,
        {
          subtype: 'conversation',
          summary,
          turns,
          ...(truncated ? { truncated: true } : {}),
          ...(gist ? { quote: gist.quote, quote_by: gist.speakerId } : {}),
        },
        sentiment,
      );
      }
    },
  );

  simEvents.on(
    'state:triggered',
    ({ agentId, state, cause }: { agentId: number; state: string; cause?: string }) => {
      const description = describeEvent('state_triggered', { state });
      memoryService.record(agentId, 'observation', description, { subtype: 'state', state, ...(cause !== undefined ? { cause } : {}) });
    },
  );

  simEvents.on('state:cleared', ({ agentId, state }: { agentId: number; state: string }) => {
    const description = describeEvent('state_cleared', { state });
    memoryService.record(agentId, 'observation', description, { subtype: 'state', state });
  });

  simEvents.on(
    'relationship:changed',
    ({ agentId, otherName, status }: { agentId: number; otherName: string; status: string }) => {
      const description = describeEvent('relationship_changed', {

        other: otherName,
        status,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'relationship', otherName, status });
    },
  );

  simEvents.on(
    'relationship:sentiment',
    ({ agentId, otherName, sentiment }: { agentId: number; otherName: string; sentiment: string }) => {
      const description = describeEvent('relationship_sentiment', {

        other: otherName,
        sentiment,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'relationship', otherName, sentiment });
    },
  );

  simEvents.on(
    'gossip:learned',
    ({ agentId, sourceName, content }: { agentId: number; sourceName: string; content: string }) => {
      const description = describeEvent('gossip_learned', {

        source: sourceName,
        content,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'gossip', sourceName, content });
    },
  );

  simEvents.on(
    'gossip:shared',
    ({ agentId, targetName, content }: { agentId: number; targetName: string; content: string }) => {
      const description = describeEvent('gossip_shared', {

        other: targetName,
        content,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'gossip', targetName, content });
    },
  );

  simEvents.on('need:critical', ({ agentId, action }: { agentId: number; action: string }) => {
    const description = describeEvent('need_critical', { need: action });
    memoryService.record(agentId, 'observation', description, { subtype: 'need', action });
  });

  simEvents.on('economy:transaction', ({ agentId, amount }: { agentId: number; amount: number }) => {
    const description = describeEvent('economy_transaction', {

      amount,
      action: 'transacted',
      item: 'goods',
    });
    memoryService.record(agentId, 'observation', description, { subtype: 'economy', amount });
  });

  simEvents.on('economy:distress', ({ agentId }: { agentId: number }) => {
    const description = describeEvent('economy_distress', {});
    memoryService.record(agentId, 'observation', description, { subtype: 'economy' });
  });

  simEvents.on('event:world', ({ agentId, name, description }: { agentId: number; name: string; description: string }) => {
    const text = description?.trim()
      ? describeEvent('world_event', { name, description })
      : `Word around town: ${endSentence(name)}`;
    memoryService.record(agentId, 'observation', text, { subtype: 'event', event: name });
  });

  simEvents.on(
    'interaction:completed',
    ({ agentId, otherName, action }: { agentId: number; otherName: string; action: string }) => {
      const description = describeEvent('interaction_completed', {

        other: otherName,
        action,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'interaction', otherName, action });
    },
  );

  simEvents.on('economy:purchase', ({ agentId, item, price, locationName }: { agentId: number; item: string; price: number; locationName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_purchase', { item, price: String(Math.round(price)), location: locationName }), { subtype: 'economy' });
  });

  // Economy events carry inventory ids ("food_raw"); memories get the item's
  // prose (itemPhrase), not the id (G9). Prose already sent ("$12", "a drink")
  // passes through unchanged.
  simEvents.on('economy:production', ({ agentId, item, quantity }: { agentId: number; item: string; quantity: number }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_production', { made: itemCountPhrase(item, quantity) }), { subtype: 'economy' });
  });

  simEvents.on('economy:blackmail_paid', ({ agentId, amount }: { agentId: number; amount: number }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_blackmail', { amount: String(Math.round(amount)) }), { subtype: 'economy' }, -0.5, 6);
  });

  simEvents.on('economy:theft_success', ({ agentId, item, locationName }: { agentId: number; item: string; locationName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_theft_success', { item: itemPhrase(item), location: locationName }), { subtype: 'economy' }, -0.3, 7);
  });

  simEvents.on('economy:theft_caught', ({ agentId, item, locationName }: { agentId: number; item: string; locationName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_theft_caught', { item: itemPhrase(item), location: locationName }), { subtype: 'economy' }, -0.7, 8);
  });

  simEvents.on('economy:milestone', ({ agentId, amount, direction }: { agentId: number; amount: number; direction: 'up' | 'down' }) => {
    const templateKey = direction === 'up' ? 'economy_milestone_up' : 'economy_milestone_down';
    const importance = direction === 'down' && amount <= 10 ? 7 : 5;
    memoryService.record(agentId, 'observation', describeEvent(templateKey, { amount: String(amount) }), { subtype: 'economy' }, direction === 'up' ? 0.3 : -0.5, importance);
    // Crossing down below $10 is a crisis — trigger stress and replan
    if (direction === 'down' && amount <= 10) {
      simEvents.emit('state:triggered', { agentId, state: 'stressed', source: 'financial_crisis' });
    }
  });

  simEvents.on('perception:observed', ({ agentId, targetName, templateKey }: { agentId: number; targetName: string; templateKey: string }) => {
    // Keyed on what was seen, not the wording: describeEvent picks a random
    // variant, so the same sighting could pass once per phrasing.
    if (!shouldRecordPerception(agentId, `${templateKey}|${targetName}`, gameMinutesNow())) return;
    memoryService.record(agentId, 'observation', describeEvent(templateKey, { target: targetName }), { subtype: 'perception', targetName });
  });

  // Goals. The goal text is either a registry key or an LLM imperative with
  // its own punctuation (goalText.ts), so it goes after a colon, normalised:
  // "I've decided to ${desc}." stored "I've decided to Assess the situation
  // with Marco....." (G9).
  simEvents.on('goal:created', ({ agentId, goalType, description }: { agentId: number; goalType: string; description?: string }) => {
    const goal = goalClause(description ?? goalType);
    memoryService.record(agentId, 'observation', endSentence(`I set myself a new goal: ${goal}`), { subtype: 'goal' }, 0, 5);
  });

  simEvents.on('goal:completed', ({ agentId, goalType, description }: { agentId: number; goalType: string; description?: string }) => {
    const goal = goalClause(description ?? goalType);
    memoryService.record(agentId, 'observation', endSentence(`I accomplished my goal: ${goal}`), { subtype: 'goal' }, 0.5, 7);
  });

  simEvents.on('goal:abandoned', ({ agentId, goalType, description, reason }: { agentId: number; goalType: string; description?: string; reason?: string }) => {
    const goal = goalClause(description ?? goalType);
    const reasonText = reason?.trim() ? ` ${endSentence(reason)}` : '';
    memoryService.record(agentId, 'observation', `${endSentence(`I gave up on my goal: ${goal}`)}${reasonText}`, { subtype: 'goal' }, -0.2, 4);
  });

  simEvents.on('goal:pivoted', ({ agentId, description, newStrategy }: { agentId: number; description: string; newStrategy: string }) => {
    const goal = goalClause(description);
    memoryService.record(agentId, 'observation', `My approach to my goal (${goal}) wasn't working. ${endSentence(`I'm going to try: ${newStrategy.trim()}`)}`, { subtype: 'goal' }, 0, 5);
  });

  simEvents.on('goal:ambition_shifted', ({ agentId, from, to, reason }: { agentId: number; from: string; to: string; reason: string }) => {
    memoryService.record(agentId, 'observation', `I used to want "${from}". Now I want "${to}" because ${reason}.`, { subtype: 'ambition' }, 0.3, 8);
  });

  simEvents.on('goal:emotional_failure', ({ agentId, importance, personality }: { agentId: number; importance: number; personality: any }) => {
    memoryService.record(agentId, 'observation', `I feel the weight of failure. My efforts didn't lead anywhere.`, { subtype: 'emotion' }, -0.5, 6);
    // Trigger emotional states based on personality — use state:triggered so cascade engine picks it up
    if (personality.neuroticism > 60) {
      const stateType = importance > 0.8 ? 'depressed' : 'stressed';
      simEvents.emit('state:triggered', { agentId, state: stateType, source: 'goal_failure' });
    } else if (personality.aggression > 60) {
      simEvents.emit('state:triggered', { agentId, state: 'angry', source: 'goal_failure' });
    }
  });

  // Gambling
  simEvents.on('economy:gambling', ({ agentId, amount, won, opponentName }: { agentId: number; amount: number; won: boolean; opponentName: string }) => {
    const template = won ? 'economy_gambling_won' : 'economy_gambling_lost';
    memoryService.record(agentId, 'observation', describeEvent(template, { amount: String(Math.round(amount)), opponent: opponentName }), { subtype: 'economy' }, won ? 0.3 : -0.4, 5);
  });

  // Seduction
  simEvents.on('social:seduction', ({ agentId, targetName }: { agentId: number; targetName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('social_seduction', { target: targetName }), { subtype: 'social' }, 0.2, 5);
  });

  // Crime: arrested
  simEvents.on('crime:arrested', ({ agentId, constableName }: { agentId: number; constableName: string }) => {
    memoryService.record(agentId, 'observation',
      describeEvent('crime_arrested', { constable: constableName }),
      { subtype: 'crime' }, -0.8, 8);
  });

  // Hobby level-up
  simEvents.on('hobby:levelup', ({ agentId, hobby, level }: { agentId: number; hobby: string; level: number }) => {
    memoryService.record(agentId, 'observation',
      `I'm getting better at ${hobby}! I'm now at skill level ${level}.`,
      { subtype: 'growth', hobby }, 0.3, 4 + Math.floor(level / 10));
  });

  // Gift given — giver remembers
  simEvents.on('gift:given', (payload: GiftGivenPayload) => {
    const receiverName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, payload.receiverId)).get()?.name ?? 'someone';
    memoryService.record(payload.giverId, 'observation',
      describeGiftForGiver(receiverName, payload),
      { subtype: 'social', related_agents: [payload.receiverId] }, 0.4, 5);
  });

  // Life milestones (lib/milestonesEngine.ts): an engagement, a refused
  // proposal, a wedding. The engine writes the first-person line itself — it
  // knows who asked whom and how it went.
  simEvents.on('life:milestone', ({ agentId, description, valence, importance, relatedAgentId }: {
    agentId: number; description: string; valence: number; importance: number; relatedAgentId?: number;
  }) => {
    memoryService.record(agentId, 'observation', description,
      { subtype: 'life_event', ...(relatedAgentId != null ? { related_agents: [relatedAgentId] } : {}) },
      valence, importance);
  });

  // Agent birthday — self-memory
  simEvents.on('agent:birthday', ({ agentId, age }: { agentId: number; age: number }) => {
    memoryService.record(agentId, 'observation',
      `Today is my birthday! I turned ${age}. Another year gone by.`,
      { subtype: 'life_event' }, 0.5, 7);
  });
}

/** Payload of `gift:given`. `reason` is set by state-driven (impulsive) gifts. */
export interface GiftGivenPayload {
  giverId: number;
  receiverId: number;
  item?: string;
  amount?: number;
  reason?: 'drunk_gift' | 'euphoric_gift';
}

/**
 * The giver's memory of a gift. Drunk and euphoric gifts are impulses, not
 * considered generosity — remembering "it felt good to be generous" after a
 * drunk evening's handout would feed reflection the wrong self-image.
 */
export function describeGiftForGiver(receiverName: string, p: GiftGivenPayload): string {
  const what = p.amount != null ? `$${p.amount}` : p.item ? itemPhrase(p.item) : 'a gift';
  switch (p.reason) {
    case 'drunk_gift':
      return `I'd had a few too many and pressed ${what} on ${receiverName}. I hope I don't regret that tomorrow.`;
    case 'euphoric_gift':
      return `I was in such a great mood that I gave ${receiverName} ${what}, just because.`;
    default:
      return `I gave a gift to ${receiverName}. It felt good to be generous.`;
  }
}
