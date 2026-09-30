import { describe, it, expect } from 'vitest';
import { alertTier } from '../alertTiers';
import { ACTIVITY_REGISTRY } from '../../data/activityRegistry';
import { activityRouter } from '../../routers/activity';
import { logActivity } from '../activityLogger';

/** Which feed rows become toasts, and in which colour. */

const row = (over: Partial<Parameters<typeof alertTier>[0]>) => ({
  type: 'drama',
  category: 'drama',
  importance: 0.8,
  agent_ids: [1, 2],
  template_data: {},
  ...over,
});

describe('alertTier', () => {
  it('always alerts the player about their own meddling', () => {
    expect(alertTier(row({ type: 'player_outcome', category: 'player', importance: 0.85 }))).toBe('player');
    expect(alertTier(row({ type: 'player_nudge_expired', category: 'player' }))).toBe('player');
    // The player's own action acknowledgements stay out: the toast already said it.
    expect(alertTier(row({ type: 'player_nudge', category: 'player', importance: 0.4 }))).toBeNull();
  });

  it('keeps the old headline rule as major', () => {
    expect(alertTier(row({}))).toBe('major');
    expect(alertTier(row({ type: 'world_event', category: 'world_event', importance: 0.9 }))).toBe('major');
    expect(alertTier(row({ importance: 0.6 }))).toBeNull();
  });

  it('splits status changes by how much they rewrite the pair', () => {
    const status = (s: string) => row({ type: 'relationship_status_change', category: 'relationship', importance: 0.7, template_data: { status: s } });
    expect(alertTier(status('partners'))).toBe('major');
    expect(alertTier(status('enemies'))).toBe('major');
    expect(alertTier(status('estranged'))).toBe('major');
    expect(alertTier(status('best_friends'))).toBe('minor');
    expect(alertTier(status('complicated'))).toBe('minor');
    expect(alertTier(status('acquaintances'))).toBeNull();
    // ...unless it's someone the player starred.
    expect(alertTier(status('acquaintances'), new Set([2]))).toBe('minor');
  });

  it('alerts goal completions quietly', () => {
    expect(alertTier(row({ type: 'goal_completed', category: 'goal', importance: 0.6 }))).toBe('minor');
  });

  it('lowers the bar for favourites, but not below social rows', () => {
    const gift = row({ type: 'gift', category: 'social', importance: 0.5, agent_ids: [7, 8] });
    expect(alertTier(gift)).toBeNull();
    expect(alertTier(gift, new Set([8]))).toBe('minor');
    expect(alertTier(row({ type: 'plan_changed', category: 'planning', importance: 0.5, agent_ids: [8] }), new Set([8]))).toBeNull();
    expect(alertTier(row({ type: 'state_gained', category: 'state', importance: 0.6, agent_ids: [8] }), new Set([8]))).toBeNull();
    // initiator/target count as involvement too.
    expect(alertTier(row({ importance: 0.55, agent_ids: [], initiator_id: 8 }), new Set([8]))).toBe('minor');
  });
});

describe('alertTier: kisses (lib/intimacy/kiss.ts)', () => {
  const kiss = (type: string, category: string, importance: number) => row({ type, category, importance, agent_ids: [7, 8] });

  it('a first kiss is a quiet toast for a favourite and nothing for everyone else', () => {
    const first = kiss('first_kiss', 'relationship', 0.65);
    expect(alertTier(first)).toBeNull();
    expect(alertTier(first, new Set([8]))).toBe('minor');
  });

  it('routine kisses and refusals never toast, favourite or not', () => {
    for (const r of [kiss('kiss', 'relationship', 0.3), kiss('kiss_rebuffed', 'drama', 0.5)]) {
      expect(alertTier(r)).toBeNull();
      expect(alertTier(r, new Set([7, 8]))).toBeNull();
    }
  });
});

describe('activity.getAlerts', () => {
  const caller = () => activityRouter.createCaller({} as any);

  it('returns tiered rows after the watermark, oldest first', async () => {
    const { latestId } = await caller().getAlerts({});
    logActivity({ type: 'relationship_status_change', agents: [901, 902], templateData: { agent1: 'A', agent2: 'B', status: 'partners' } });
    logActivity({ type: 'purchase', agents: [901], templateData: { agent: 'A', item: 'bread', amount: 2 } });
    logActivity({ type: 'player_outcome', agents: [901, 902], templateData: { description: 'Your nudge: A & B — it went well.' } });
    logActivity({ type: 'gift', agents: [903, 904], templateData: { description: 'C gave D flowers' } });

    const plain = await caller().getAlerts({ sinceId: latestId });
    expect(plain.alerts.map((a) => [a.type, a.tier])).toEqual([
      ['relationship_status_change', 'major'],
      ['player_outcome', 'player'],
    ]);
    expect(plain.latestId).toBeGreaterThan(latestId);

    const starred = await caller().getAlerts({ sinceId: latestId, favoriteIds: [904] });
    expect(starred.alerts.map((a) => [a.type, a.tier])).toEqual([
      ['relationship_status_change', 'major'],
      ['player_outcome', 'player'],
      ['gift', 'minor'],
    ]);
  });

  it('keeps the newest rows when more arrive than the limit', async () => {
    const { latestId } = await caller().getAlerts({});
    for (let i = 0; i < 4; i++) {
      logActivity({ type: 'drama', agents: [905], severity: 0.5, templateData: { description: `drama ${i}` } });
    }
    const { alerts } = await caller().getAlerts({ sinceId: latestId, limit: 2 });
    expect(alerts.map((a) => (a.template_data as Record<string, string>).description)).toEqual(['drama 2', 'drama 3']);
  });
});

describe('alertTier: trysts (lib/intimacy/tryst.ts)', () => {
  const tryst = (type: string, category: string, importance: number) => row({ type, category, importance, agent_ids: [7, 8, 9] });

  it('a night together is quiet: a minor toast for a favourite, nothing for everyone else', () => {
    const night = tryst('tryst', 'relationship', 0.5);
    expect(alertTier(night)).toBeNull();
    expect(alertTier(night, new Set([8]))).toBe('minor');
  });

  it('being seen leaving at dawn is a scandal: major for a favourite, a minor toast for anyone else', () => {
    const seen = tryst('caught', 'drama', 0.75);
    expect(alertTier(seen)).toBe('minor');
    expect(alertTier(seen, new Set([7]))).toBe('major');
    // A favourite who only saw it counts too: it is their story.
    expect(alertTier(seen, new Set([9]))).toBe('major');
  });
});

describe('alertTier: the whole intimacy table, at the registry\'s own importances', () => {
  // [type, tier for nobody in particular, tier when a favourite is in the row]
  const TABLE: Array<[string, 'major' | 'minor' | null, 'major' | 'minor' | null]> = [
    ['first_kiss', null, 'minor'],
    ['kiss', null, null],
    ['kiss_rebuffed', null, null],
    ['tryst', null, 'minor'],
    ['caught', 'minor', 'major'],
    ['scandal', 'major', 'major'],
    ['suspicion', null, 'minor'],
  ];

  for (const [type, stranger, favourite] of TABLE) {
    it(`${type}: ${stranger ?? 'no toast'} for the town, ${favourite ?? 'no toast'} for a favourite`, () => {
      const def = ACTIVITY_REGISTRY[type];
      const r = row({ type, category: def.category, importance: def.base_importance, agent_ids: [7, 8, 9], initiator_id: 7, target_id: 8 });
      expect(alertTier(r)).toBe(stranger);
      expect(alertTier(r, new Set([8]))).toBe(favourite);
    });
  }
});
