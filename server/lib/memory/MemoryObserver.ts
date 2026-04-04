import { simEvents } from '../simEvents';
import { describeEvent } from './descriptionTemplates';
import type { MemoryService } from './MemoryService';

export function initMemoryObserver(memoryService: MemoryService): void {
  simEvents.on('agent:arrived', ({ agentId, locationName }: { agentId: number; locationName: string }) => {
    const description = describeEvent('arrival', { location: locationName });
    memoryService.record(agentId, 'observation', description, { subtype: 'movement' });
  });

  simEvents.on('agent:departed', ({ agentId, locationName }: { agentId: number; locationName: string }) => {
    const description = describeEvent('departure', { location: locationName });
    memoryService.record(agentId, 'observation', description, { subtype: 'movement' });
  });

  simEvents.on('conversation:started', ({ agentId, otherName }: { agentId: number; otherName: string }) => {
    const description = describeEvent('conversation_start', { other: otherName });
    memoryService.record(agentId, 'observation', description, { subtype: 'conversation' });
  });

  simEvents.on(
    'conversation:ended',
    ({
      agentId,
      otherName,
      summary,
      turns,
      sentiment,
    }: {
      agentId: number;
      otherName: string;
      summary: string;
      turns: number;
      sentiment: number;
    }) => {
      const description = describeEvent('conversation_end', {

        other: otherName,
        summary,
        turns,
      });
      memoryService.record(
        agentId,
        'conversation',
        description,
        { subtype: 'conversation', summary, turns },
        sentiment,
      );
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

  simEvents.on('event:world', ({ agentId, event }: { agentId: number; event: string }) => {
    const description = describeEvent('world_event', { event, location: 'town' });
    memoryService.record(agentId, 'observation', description, { subtype: 'event', event });
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

  simEvents.on('economy:production', ({ agentId, item, quantity }: { agentId: number; item: string; quantity: number }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_production', { item, quantity: String(quantity) }), { subtype: 'economy' });
  });

  simEvents.on('economy:blackmail_paid', ({ agentId, amount }: { agentId: number; amount: number }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_blackmail', { amount: String(Math.round(amount)) }), { subtype: 'economy' }, -0.5, 6);
  });

  simEvents.on('economy:theft_success', ({ agentId, item, locationName }: { agentId: number; item: string; locationName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_theft_success', { item, location: locationName }), { subtype: 'economy' }, -0.3, 7);
  });

  simEvents.on('economy:theft_caught', ({ agentId, item, locationName }: { agentId: number; item: string; locationName: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('economy_theft_caught', { item, location: locationName }), { subtype: 'economy' }, -0.7, 8);
  });

  simEvents.on('economy:milestone', ({ agentId, amount, direction }: { agentId: number; amount: number; direction: 'up' | 'down' }) => {
    const templateKey = direction === 'up' ? 'economy_milestone_up' : 'economy_milestone_down';
    memoryService.record(agentId, 'observation', describeEvent(templateKey, { amount: String(amount) }), { subtype: 'economy' }, direction === 'up' ? 0.3 : -0.3, 5);
  });

  simEvents.on('perception:observed', ({ agentId, targetName, templateKey }: { agentId: number; targetName: string; templateKey: string }) => {
    memoryService.record(agentId, 'observation',
      describeEvent(templateKey, { target: targetName }),
      { subtype: 'perception', targetName });
  });

  // Goals
  simEvents.on('goal:created', ({ agentId, goalType }: { agentId: number; goalType: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('goal_created', { goal: goalType }), { subtype: 'goal' }, 0, 5);
  });

  simEvents.on('goal:completed', ({ agentId, goalType }: { agentId: number; goalType: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('goal_completed', { goal: goalType }), { subtype: 'goal' }, 0.5, 7);
  });

  simEvents.on('goal:abandoned', ({ agentId, goalType }: { agentId: number; goalType: string }) => {
    memoryService.record(agentId, 'observation', describeEvent('goal_abandoned', { goal: goalType }), { subtype: 'goal' }, -0.2, 4);
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
}
