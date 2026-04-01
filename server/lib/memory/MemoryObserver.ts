import { simEvents } from '../simEvents';
import { describeEvent } from './descriptionTemplates';
import type { MemoryService } from './MemoryService';

export function initMemoryObserver(memoryService: MemoryService): void {
  simEvents.on('agent:arrived', ({ agentId, locationName }: { agentId: number; locationName: string }) => {
    const description = describeEvent('arrival', { agent: String(agentId), location: locationName });
    memoryService.record(agentId, 'observation', description, { subtype: 'movement' });
  });

  simEvents.on('agent:departed', ({ agentId, locationName }: { agentId: number; locationName: string }) => {
    const description = describeEvent('departure', { agent: String(agentId), location: locationName });
    memoryService.record(agentId, 'observation', description, { subtype: 'movement' });
  });

  simEvents.on('conversation:started', ({ agentId, otherName }: { agentId: number; otherName: string }) => {
    const description = describeEvent('conversation_start', { agent: String(agentId), other: otherName });
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
        agent: String(agentId),
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
      const description = describeEvent('state_triggered', { agent: String(agentId), state });
      memoryService.record(agentId, 'observation', description, { subtype: 'state', state, ...(cause !== undefined ? { cause } : {}) });
    },
  );

  simEvents.on('state:cleared', ({ agentId, state }: { agentId: number; state: string }) => {
    const description = describeEvent('state_cleared', { agent: String(agentId), state });
    memoryService.record(agentId, 'observation', description, { subtype: 'state', state });
  });

  simEvents.on(
    'relationship:changed',
    ({ agentId, otherName, status }: { agentId: number; otherName: string; status: string }) => {
      const description = describeEvent('relationship_changed', {
        agent: String(agentId),
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
        agent: String(agentId),
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
        agent: String(agentId),
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
        agent: String(agentId),
        other: targetName,
        content,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'gossip', targetName, content });
    },
  );

  simEvents.on('need:critical', ({ agentId, action }: { agentId: number; action: string }) => {
    const description = describeEvent('need_critical', { agent: String(agentId), need: action });
    memoryService.record(agentId, 'observation', description, { subtype: 'need', action });
  });

  simEvents.on('economy:transaction', ({ agentId, amount }: { agentId: number; amount: number }) => {
    const description = describeEvent('economy_transaction', {
      agent: String(agentId),
      amount,
      action: 'transacted',
      item: 'goods',
    });
    memoryService.record(agentId, 'observation', description, { subtype: 'economy', amount });
  });

  simEvents.on('economy:distress', ({ agentId }: { agentId: number }) => {
    const description = describeEvent('economy_distress', { agent: String(agentId) });
    memoryService.record(agentId, 'observation', description, { subtype: 'economy' });
  });

  simEvents.on('event:world', ({ agentId, event }: { agentId: number; event: string }) => {
    const description = describeEvent('world_event', { agent: String(agentId), event, location: 'town' });
    memoryService.record(agentId, 'observation', description, { subtype: 'event', event });
  });

  simEvents.on(
    'interaction:completed',
    ({ agentId, otherName, action }: { agentId: number; otherName: string; action: string }) => {
      const description = describeEvent('interaction_completed', {
        agent: String(agentId),
        other: otherName,
        action,
      });
      memoryService.record(agentId, 'observation', description, { subtype: 'interaction', otherName, action });
    },
  );
}
