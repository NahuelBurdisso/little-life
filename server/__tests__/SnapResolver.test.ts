import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { activityLog, agents, agentStates, locations, needs } from '../db/schema';
import { simEvents } from '../lib/simEvents';
import { dominantGrievance } from '../lib/cascade/TensionTracker';
import { isDramaBeat } from '../data/dramaBeats';
import type { SnapAction } from '../lib/cascade/cascadeTypes';
import { parseSnapResponse, SnapResolver } from '../lib/cascade/SnapResolver';

describe('parseSnapResponse', () => {
  it('exact match: confront', () => {
    expect(parseSnapResponse('confront')).toBe('confront');
  });

  it('uppercase: FLEE', () => {
    expect(parseSnapResponse('FLEE')).toBe('flee');
  });

  it('verbose with label: Action: breakdown', () => {
    expect(parseSnapResponse('Action: breakdown')).toBe('breakdown');
  });

  it('mid-sentence uppercase: I think the best action would be to PLOT revenge.', () => {
    expect(parseSnapResponse('I think the best action would be to PLOT revenge.')).toBe('plot');
  });

  it('lash_out at start of sentence', () => {
    expect(parseSnapResponse('lash_out seems right')).toBe('lash_out');
  });

  it('empty string → breakdown', () => {
    expect(parseSnapResponse('')).toBe('breakdown');
  });

  it('gibberish → breakdown', () => {
    expect(parseSnapResponse('xkcd quantum banana')).toBe('breakdown');
  });

  it('self_destruct exact match', () => {
    expect(parseSnapResponse('self_destruct')).toBe('self_destruct');
  });

  it('mixed case: pLoT', () => {
    expect(parseSnapResponse('pLoT')).toBe('plot');
  });
});

describe('SnapResolver.buildSnapPrompt', () => {
  const resolver = new SnapResolver();

  const baseCtx = {
    agentName: 'Maria',
    personalitySummary: 'Empathetic but easily overwhelmed, prone to anxiety',
    tensionSources: [
      { event: 'argument', description: 'Had a heated argument with her boss', tick: 42 },
      { event: 'gossip', description: 'Found out her friend spread rumors about her', tick: 45 },
    ],
    activeStates: ['stressed', 'anxious'],
    activeGoals: ['find a new job', 'repair friendship with Luis'],
  };

  it('contains the agent name', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Maria');
  });

  it('contains the personality summary', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Empathetic but easily overwhelmed, prone to anxiety');
  });

  it('contains each tension source description', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('Had a heated argument with her boss');
    expect(prompt).toContain('Found out her friend spread rumors about her');
  });

  it('contains all 6 action options', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('confront');
    expect(prompt).toContain('flee');
    expect(prompt).toContain('plot');
    expect(prompt).toContain('breakdown');
    expect(prompt).toContain('lash_out');
    expect(prompt).toContain('self_destruct');
  });

  it('lists active states', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('stressed');
    expect(prompt).toContain('anxious');
  });

  it('lists active goals', () => {
    const prompt = resolver.buildSnapPrompt(baseCtx);
    expect(prompt).toContain('find a new job');
  });

  it('shows "none" when no states are present', () => {
    const ctx = { ...baseCtx, activeStates: [] };
    const prompt = resolver.buildSnapPrompt(ctx);
    expect(prompt).toContain('none');
  });

  it('shows "none" when no goals are present', () => {
    const ctx = { ...baseCtx, activeGoals: [] };
    const prompt = resolver.buildSnapPrompt(ctx);
    expect(prompt).toContain('none');
  });
});

describe('parseSnapResponse — spelling variants', () => {
  it('reads "lash out" and "self-destruct" as their action names', () => {
    expect(parseSnapResponse('Lash out')).toBe('lash_out');
    expect(parseSnapResponse('self-destruct')).toBe('self_destruct');
    expect(parseSnapResponse('{"action":"plot"}')).toBe('plot');
  });
});

/**
 * A snap used to fizzle: the confrontation carried no perpetrator/victim (goals.ts drops it),
 * the plot's `angry` state had no target (the revenge trigger needs `has_target`), and four of
 * the six rows had no `metadata.beat` (invisible to the story-health tally). The culprit is the
 * resident most of the grievances name (`agentInvolved`, a NAME), resolved to an active agent.
 */
describe('dominantGrievance', () => {
  it('picks the most frequent name, the newest on a tie, and null when nobody is named', () => {
    const src = (agentInvolved?: string) => ({ event: 'e', description: 'd', tick: 1, ...(agentInvolved ? { agentInvolved } : {}) });
    expect(dominantGrievance([src('Ana'), src('Bo'), src('Bo')])).toEqual({ name: 'Bo', share: 2 / 3 });
    expect(dominantGrievance([src('Ana'), src('Bo')])!.name).toBe('Bo');
    expect(dominantGrievance([src(), src()])).toBeNull();
    expect(dominantGrievance([])).toBeNull();
  });
});

describe('SnapResolver.executeSnapAction: the culprit', () => {
  const resolver = new SnapResolver();
  let home: number;
  let snapper: number;
  let culprit: number;
  let gone: number;
  const named = (name: string | null, n = 1) =>
    Array.from({ length: n }, (_, i) => ({
      event: 'interaction:completed', description: `grievance ${i}`, tick: i,
      ...(name ? { agentInvolved: name } : {}),
    }));

  function insertAgent(name: string, active = true): number {
    return db.insert(agents).values({
      name, bio: 'test', traits: [],
      personality: { honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50, curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50 },
      age: 30, gender: 'female', sprite_sheet: 'x', portrait_sprite: 'x',
      position: { x: 0, y: 0 }, current_destination: null, current_location: home,
      current_action: { type: 'idle' }, action_started: 0, action_duration: null,
      action_queue: [], current_path: null,
      schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home, workplace: null, created_at: Date.now(), is_active: active,
    }).returning({ id: agents.id }).get().id;
  }

  beforeAll(() => {
    home = db.insert(locations).values({
      name: 'snap home', type: 'home',
      position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 1, y: 4 },
      owner: null, capacity: 4, current_occupants: [], operating_hours: null, services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    snapper = insertAgent('Snap Snapper');
    culprit = insertAgent('Snap Culprit');
    gone = insertAgent('Snap Departed', false);
  });

  beforeEach(() => {
    db.delete(activityLog).run();
    db.delete(agentStates).where(eq(agentStates.agent_id, snapper)).run();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => {
    db.delete(activityLog).run();
    db.delete(agentStates).where(eq(agentStates.agent_id, snapper)).run();
    db.delete(needs).where(eq(needs.agent_id, snapper)).run();
  });

  const rows = () => db.select().from(activityLog).all();

  it('confront carries the snapper as perpetrator and the culprit as victim, the way goals.ts reads it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (p: Record<string, unknown>) => { seen.push(p); };
    simEvents.on('interaction:completed', listener);
    try {
      await resolver.executeSnapAction(snapper, 'confront', named('Snap Culprit', 2), { chainId: 'c' });
    } finally {
      simEvents.off('interaction:completed', listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: snapper, perpetratorId: snapper, victimId: culprit, action: 'confrontation' });
    const [row] = rows();
    expect(row.initiator_id).toBe(snapper);
    expect(row.target_id).toBe(culprit);
    expect((row.metadata as { beat?: string }).beat).toBe('snap');
  });

  it('plot gives the angry state a target, so the revenge trigger can fire', async () => {
    await resolver.executeSnapAction(snapper, 'plot', named('Snap Culprit', 2), { chainId: 'c' });
    const st = db.select().from(agentStates).where(eq(agentStates.agent_id, snapper)).all();
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ type: 'angry', target_agent_id: culprit, source: 'snap:plot' });
  });

  it('plot aims an angry state that already exists but has no target', async () => {
    db.insert(agentStates).values({
      agent_id: snapper, type: 'angry', severity: 0.4, started_at: 0, duration: 240, source: 'other', metadata: {},
    }).run();
    await resolver.executeSnapAction(snapper, 'plot', named('Snap Culprit'), { chainId: 'c' });
    const st = db.select().from(agentStates).where(eq(agentStates.agent_id, snapper)).all();
    expect(st).toHaveLength(1);
    expect(st[0].target_agent_id).toBe(culprit);
  });

  it('every action logs a drama row tagged with a known beat', async () => {
    const actions: SnapAction[] = ['confront', 'flee', 'plot', 'breakdown', 'lash_out', 'self_destruct'];
    for (const a of actions) {
      db.delete(activityLog).run();
      await resolver.executeSnapAction(snapper, a, named('Snap Culprit'), { chainId: 'c' });
      const r = rows();
      expect(r, a).toHaveLength(1);
      expect(r[0].category, a).toBe('drama');
      const beat = (r[0].metadata as { beat?: string } | null)?.beat;
      expect(isDramaBeat(beat), `${a} beat`).toBe(true);
    }
  });

  it('with nobody to blame nothing crashes: confront has no victim, plot no target', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (p: Record<string, unknown>) => { seen.push(p); };
    simEvents.on('interaction:completed', listener);
    try {
      await expect(resolver.executeSnapAction(snapper, 'confront', [], { chainId: 'c' })).resolves.toBeUndefined();
      await expect(resolver.executeSnapAction(snapper, 'plot', named(null, 2), { chainId: 'c' })).resolves.toBeUndefined();
    } finally {
      simEvents.off('interaction:completed', listener);
    }
    expect(seen[0].victimId ?? null).toBeNull();
    const st = db.select().from(agentStates).where(eq(agentStates.agent_id, snapper)).all();
    expect(st[0].target_agent_id).toBeNull();
    expect(rows().every(r => isDramaBeat((r.metadata as { beat?: string }).beat))).toBe(true);
  });

  it('a culprit who left town, an unknown name, or the snapper themself is not a culprit', async () => {
    for (const name of ['Snap Departed', 'Nobody Atall', 'Snap Snapper']) {
      db.delete(agentStates).where(eq(agentStates.agent_id, snapper)).run();
      await resolver.executeSnapAction(snapper, 'plot', named(name), { chainId: 'c' });
      const st = db.select().from(agentStates).where(eq(agentStates.agent_id, snapper)).all();
      expect(st[0].target_agent_id, name).toBeNull();
    }
    expect(gone).toBeGreaterThan(0);
  });
});
