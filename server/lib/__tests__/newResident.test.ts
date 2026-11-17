import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, economy, locations, needs, worldState } from '../../db/schema';
import { nudgeRouter } from '../../routers/nudge';
import { generateNewResident, guessGender } from '../newResident';
import { makeRng } from '../worldgen/rng';
import { AGENT_SEEDS } from '../../data/agents';
import { CONFIG } from '../constants';

const base = { name: 'Rosa Fernandez', bio: '', traits: [] as string[], job: 'baker', worldSeed: 'seed-1' };
const AXES = ['honesty', 'aggression', 'warmth', 'impulsiveness', 'vanity', 'curiosity', 'loyalty', 'morality', 'sensuality', 'neuroticism'];

describe('generateNewResident', () => {
  it('rolls a full personality in the seeded agents\' shape, deterministic per world and name', () => {
    const a = generateNewResident(base);
    expect(Object.keys(a.personality).sort()).toEqual([...AXES].sort());
    for (const v of Object.values(a.personality)) {
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(95);
    }
    expect(generateNewResident(base)).toEqual(a);
    // Another town rolls someone else under the same name.
    expect(generateNewResident({ ...base, worldSeed: 'seed-2' }).personality).not.toEqual(a.personality);
  });

  it("works the job's real hours from the seeded cast, and none when jobless", () => {
    const bakerSeed = AGENT_SEEDS.find((s) => s.job === 'baker')!;
    const baker = generateNewResident(base);
    expect(baker.schedule.workStart).toBe(bakerSeed.schedule.workStart);
    expect(baker.schedule.workEnd).toBe(bakerSeed.schedule.workEnd);
    expect(baker.schedule.wakeTime).toBe(bakerSeed.schedule.wakeTime);
    expect(baker.salary).toBe(bakerSeed.salary);
    expect(baker.jobTitle).toBe('Baker');

    const bartender = generateNewResident({ ...base, job: 'bartender' });
    expect(bartender.schedule.workStart).toBeGreaterThanOrEqual(12);

    const idle = generateNewResident({ ...base, job: 'unemployed' });
    expect(idle.schedule.workStart).toBe(0);
    expect(idle.schedule.workEnd).toBe(0);
    expect(idle.salary).toBe(20);
    expect(idle.jobTitle).toBe('Unemployed');
    expect(generateNewResident({ ...base, job: 'shop_assistant' }).jobTitle).toBe('Shop Assistant');
  });

  it('prefers real location types for free time, and only ones the town has', () => {
    const r = generateNewResident({ ...base, availableLocationTypes: ['home', 'park', 'bakery'] });
    expect(r.schedule.freeTimePreferences.length).toBeGreaterThan(0);
    for (const t of r.schedule.freeTimePreferences) expect(['home', 'park']).toContain(t);
    const full = generateNewResident(base);
    for (const t of full.schedule.freeTimePreferences) expect(['park', 'tavern', 'town_square', 'home']).toContain(t);
  });

  it('leans the personality toward the traits the player picked', () => {
    let caring = 0;
    let cold = 0;
    for (let i = 0; i < 40; i++) {
      caring += generateNewResident({ ...base, worldSeed: i, traits: ['caring', 'generous'] }).personality.warmth;
      cold += generateNewResident({ ...base, worldSeed: i, traits: ['introverted'] }).personality.warmth;
    }
    expect(caring / 40).toBeGreaterThan(cold / 40 + 20);
  });

  it('writes a template bio when the player left it blank, and keeps theirs otherwise', () => {
    const r = generateNewResident({ ...base, traits: ['patient'] });
    expect(r.bio).toMatch(/^Rosa has just moved to town to work as a baker\./);
    expect(r.bio).toContain('patient');
    expect(generateNewResident({ ...base, bio: '  My own words.  ' }).bio).toBe('My own words.');
    // With no traits, words from the rolled personality stand in (or none, if bland).
    const plain = generateNewResident({ ...base, job: 'retired' });
    expect(plain.bio).toMatch(/^Rosa has just moved to town to spend the quiet years/);
    expect(plain.traits.length).toBeLessThanOrEqual(2);
  });

  it('draws an age for the job and a gender from the name', () => {
    expect(generateNewResident({ ...base, job: 'retired' }).age).toBeGreaterThanOrEqual(60);
    const rng = makeRng(1);
    expect(guessGender('Rosa Fernandez', rng)).toBe('female');
    expect(guessGender('Marco Rivera', rng)).toBe('male');
    expect(guessGender('Luca Bianchi', rng)).toBe('male');
    expect(guessGender('Dr. Anna Petrov', rng)).toBe('female');
  });

  it('starts needs in the seeded ranges', () => {
    const { needs: n } = generateNewResident(base);
    const r = CONFIG.NEEDS.STARTING_RANGES;
    expect(n.hunger).toBeGreaterThanOrEqual(r.hunger[0]);
    expect(n.hunger).toBeLessThan(r.hunger[1]);
    expect(n.social).toBeGreaterThanOrEqual(r.social[0]);
    expect(n.mood).toBeGreaterThanOrEqual(58);
    expect(n.stress).toBeLessThanOrEqual(30);
  });
});

describe('nudge.introduce_agent', () => {
  it('stores a resident with a personality, a real schedule, gender, age and needs', async () => {
    if (!db.select().from(worldState).get()) {
      db.insert(worldState).values({
        time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' },
        day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
        last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
        map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    db.insert(locations).values({
      name: 'Home 99', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 1, y: 4 },
      owner: null, capacity: 4, current_occupants: [], operating_hours: null, services: [], description: 'test',
    }).run();

    const res = await nudgeRouter.createCaller({}).execute({
      action: { type: 'introduce_agent', name: 'Tomas Ortega', bio: '', traits: ['caring'], job: 'bartender' },
    });
    expect(res.success).toBe(true);
    const id = (res as { agentId: number }).agentId;
    const row = db.select().from(agents).where(eq(agents.id, id)).get()!;
    expect(row.personality).not.toBeNull();
    expect(row.gender).toBe('male');
    expect(row.bio).toContain('Tomas has just moved to town');
    const schedule = row.schedule as { workStart: number; freeTimePreferences: string[] };
    expect(schedule.workStart).toBe(AGENT_SEEDS.find((s) => s.job === 'bartender')!.schedule.workStart);
    expect(schedule.freeTimePreferences).not.toContain('socializing');
    const n = db.select().from(needs).where(eq(needs.agent_id, id)).get()!;
    expect(n.hunger).toBeLessThanOrEqual(90);
    const econ = db.select().from(economy).where(eq(economy.agent_id, id)).get()!;
    expect(econ.job_title).toBe('Bartender');
  });
});
