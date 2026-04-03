import { db } from '../../db';
import { memories, agents } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import type { MemoryService } from './MemoryService';
import type { MemoryStore } from './MemoryStore';

const TICKS_PER_DAY = 1440;
const RETENTION = {
  routine: 5,    // importance 1-3: keep 5 days
  moderate: 15,  // importance 4-6: keep 15 days
  plan: 10,      // type=plan: keep 10 days
};
const MIN_GROUP_SIZE = 5;

interface MemoryCandidate {
  id: number;
  agent_id: number;
  type: string;
  description: string;
  importance: number;
  created_at: number;
  metadata: Record<string, unknown>;
}

interface GroupedMemories {
  agentId: number;
  weekNumber: number;
  type: string;
  memories: MemoryCandidate[];
  startDay: number;
  endDay: number;
}

export class MemoryConsolidator {
  constructor(
    private memoryService: MemoryService,
    private store: MemoryStore,
  ) {}

  consolidate(currentDay: number, currentTick: number): void {
    const allAgents = db.select({ id: agents.id }).from(agents).all();
    let totalDeactivated = 0;
    let totalSummaries = 0;

    for (const agent of allAgents) {
      const { deactivated, summaries } = this.consolidateAgent(agent.id, currentDay, currentTick);
      totalDeactivated += deactivated;
      totalSummaries += summaries;
    }

    if (totalDeactivated > 0) {
      console.log(`[MemoryConsolidator] Deactivated ${totalDeactivated} old memories, created ${totalSummaries} summaries`);
    }
  }

  private consolidateAgent(agentId: number, _currentDay: number, currentTick: number): { deactivated: number; summaries: number } {
    // Find candidates for deactivation
    const routineCutoff = currentTick - RETENTION.routine * TICKS_PER_DAY;
    const moderateCutoff = currentTick - RETENTION.moderate * TICKS_PER_DAY;
    const planCutoff = currentTick - RETENTION.plan * TICKS_PER_DAY;

    // Query all active memories for this agent that might be candidates
    const allActive = db.select().from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, 1)))
      .all() as unknown as MemoryCandidate[];

    const candidates = allActive.filter(m => {
      // Never deactivate reflections
      if (m.type === 'reflection') return false;
      // Never deactivate significant memories
      if (m.importance >= 7) return false;
      // Summaries are never re-consolidated
      if ((m.metadata as any)?.subtype === 'summary') return false;

      // Routine (1-3): deactivate after 5 days
      if (m.importance <= 3 && m.created_at < routineCutoff) return true;
      // Moderate (4-6, non-plan): deactivate after 15 days
      if (m.importance > 3 && m.importance <= 6 && m.type !== 'plan' && m.created_at < moderateCutoff) return true;
      // Plans: deactivate after 10 days
      if (m.type === 'plan' && m.created_at < planCutoff) return true;

      return false;
    });

    if (candidates.length === 0) return { deactivated: 0, summaries: 0 };

    // Group by week + type
    const groups = this.groupByWeekAndType(candidates, agentId);

    // Generate summaries for large groups
    let summaryCount = 0;
    for (const group of groups) {
      if (group.memories.length >= MIN_GROUP_SIZE) {
        const summaryText = this.generateSummary(group);
        this.memoryService.record(
          agentId, 'observation', summaryText,
          { subtype: 'summary', source_count: group.memories.length, day_range: [group.startDay, group.endDay] },
          0, 4 // neutral valence, moderate importance
        );
        summaryCount++;
      }
    }

    // Deactivate all candidates
    const ids = candidates.map(m => m.id);
    this.store.deactivateBatch(ids);

    return { deactivated: ids.length, summaries: summaryCount };
  }

  private groupByWeekAndType(candidates: MemoryCandidate[], agentId: number): GroupedMemories[] {
    const groupMap = new Map<string, GroupedMemories>();

    for (const m of candidates) {
      const weekNumber = Math.floor(m.created_at / (TICKS_PER_DAY * 7));
      const key = `${agentId}-${weekNumber}-${m.type}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          agentId,
          weekNumber,
          type: m.type,
          memories: [],
          startDay: Math.floor(m.created_at / TICKS_PER_DAY) + 1,
          endDay: Math.floor(m.created_at / TICKS_PER_DAY) + 1,
        });
      }

      const group = groupMap.get(key)!;
      group.memories.push(m);
      const day = Math.floor(m.created_at / TICKS_PER_DAY) + 1;
      group.startDay = Math.min(group.startDay, day);
      group.endDay = Math.max(group.endDay, day);
    }

    return [...groupMap.values()];
  }

  private generateSummary(group: GroupedMemories): string {
    const dayRange = group.startDay === group.endDay
      ? `day ${group.startDay}`
      : `days ${group.startDay}-${group.endDay}`;

    // Count subtypes
    const subtypeCounts = new Map<string, number>();
    const locationMentions = new Map<string, number>();
    const agentMentions = new Map<string, number>();

    for (const m of group.memories) {
      const meta = m.metadata as Record<string, any>;
      const subtype = meta?.subtype ?? group.type;
      subtypeCounts.set(subtype, (subtypeCounts.get(subtype) ?? 0) + 1);

      if (meta?.location_name) locationMentions.set(meta.location_name, (locationMentions.get(meta.location_name) ?? 0) + 1);
      if (meta?.otherName) agentMentions.set(meta.otherName, (agentMentions.get(meta.otherName) ?? 0) + 1);
    }

    const parts: string[] = [];

    // Top activities
    const topActivities = [...subtypeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([subtype]) => this.describeActivity(subtype));
    if (topActivities.length > 0) {
      parts.push(`spent most of my time ${topActivities.join(', ')}`);
    }

    // Top locations
    const topLocations = [...locationMentions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    if (topLocations.length > 0) {
      parts.push(`frequented ${topLocations.join(', ')}`);
    }

    // Top agents
    const topAgents = [...agentMentions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    if (topAgents.length > 0) {
      parts.push(`talked often with ${topAgents.join(' and ')}`);
    }

    if (parts.length === 0) {
      return `During ${dayRange}, I went about my routine.`;
    }

    return `During ${dayRange}, I ${parts.join('. I ')}.`;
  }

  private describeActivity(subtype: string): string {
    switch (subtype) {
      case 'movement': return 'moving around town';
      case 'conversation': return 'socializing';
      case 'economy': return 'working and handling finances';
      case 'state': return 'dealing with emotional changes';
      case 'need': return 'taking care of basic needs';
      case 'gossip': return 'hearing and sharing gossip';
      case 'relationship': return 'navigating relationships';
      case 'interaction': return 'interacting with others';
      default: return subtype;
    }
  }
}
