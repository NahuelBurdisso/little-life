import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { getTableName } from 'drizzle-orm';

// The tick loop is replaced for the whole file: `initialize` would otherwise
// start it (and with it LLM dispatches), and a save/load stops and restarts it.
// Mocking also lets the tests see *whether* a flow restarts it.
vi.mock('../../engine/tick', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/tick')>();
  return {
    ...actual,
    startTickLoop: vi.fn(),
    stopTickLoopAndWait: vi.fn(async () => {}),
    isTickLoopRunning: vi.fn(() => false),
  };
});

import { sqlite, initSchema } from '../../db';
import { ALL_TABLES } from '../../db/worldTables';
import { isTickLoopRunning, startTickLoop, stopTickLoopAndWait } from '../../engine/tick';
import { getHobbyLevel, practiceHobby } from '../hobbyEngine';
import { CONFIG as GAME_CONFIG } from '../constants';
import {
  autosave,
  deleteSave,
  listSaves,
  loadSave,
  pruneAutosaves,
  saveWorld,
  SaveRejectedError,
  setSavesDir,
} from '../saves';

// ─── A small real town, built the way the wizard's Start builds it ────────────

const PERSONALITY = {
  honesty: 50, aggression: 20, warmth: 60, impulsiveness: 30, vanity: 25,
  curiosity: 55, loyalty: 65, morality: 70, sensuality: 35, neuroticism: 40,
};

function makeAgent(n: number) {
  return {
    id: `agent-${n}`,
    name: `Saver ${n}`,
    age: 30 + n,
    gender: 'neutral',
    bio: `Bio ${n}`,
    traits: ['friendly'],
    job: 'laborer',
    jobTitle: 'Laborer',
    salary: 20,
    homeName: `Home ${n}`,
    workplaceName: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: ['park'] },
    personality: PERSONALITY,
    backstoryMemories: [`Saver ${n} grew up by the river.`],
  };
}

const CONFIG = {
  agents: [1, 2, 3, 4].map(makeAgent),
  relationships: [],
  world: { season: 'spring' as const, weather: 'sunny', startHour: 9, startDay: 1 },
  rules: { startingMoney: 50, tickSpeed: 1 },
  worldgen: { sizeTier: 'auto' as const, overrides: {}, seed: 'saves-test-seed' },
};

const TABLES = [...ALL_TABLES.map((t) => getTableName(t)), 'app_meta'];

/**
 * Every row of every table a load replaces, in storage order. With
 * `ignoreCheckpointTime`, the wall-clock `saved_at` of the sim snapshots is
 * left out: a load re-checkpoints the outgoing world before it starts (that is
 * what a rolled-back load restores from), so the stamp moves while the
 * content stays the same.
 */
function dumpWorld(opts: { ignoreCheckpointTime?: boolean } = {}): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = sqlite.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  if (opts.ignoreCheckpointTime) {
    out.sim_snapshots = out.sim_snapshots.map((r) => ({ ...(r as object), saved_at: 0 }));
  }
  return out;
}

function userVersion(): number {
  return sqlite.pragma('user_version', { simple: true }) as number;
}

function firstAgentId(): number {
  return (sqlite.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as { id: number }).id;
}

/** Scribble over the world so a load has something to undo. */
function mutateWorld(): void {
  sqlite.prepare("UPDATE agents SET name = 'Somebody Else'").run();
  sqlite.prepare('DELETE FROM memories WHERE id = (SELECT min(id) FROM memories)').run();
  sqlite.prepare('DELETE FROM relationships').run();
  sqlite.prepare("UPDATE world_state SET weather = 'stormy', tax_pool = tax_pool + 999").run();
  sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('scribble', 'x') ON CONFLICT(key) DO UPDATE SET value = 'x'").run();
}

let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-saves-'));
  setSavesDir(dir);
  const { setupRouter } = await import('../../routers/setup');
  await setupRouter.createCaller({} as never).initialize(CONFIG as never);
  // The same self heal a load runs, applied once up front, so "rows restored
  // exactly" compares like with like.
  initSchema();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(startTickLoop).mockClear();
  vi.mocked(stopTickLoopAndWait).mockClear();
  vi.mocked(isTickLoopRunning).mockClear();
});

describe('saves', () => {
  it('save → mutate → load restores every row, and the in-memory sim state', async () => {
    const agentId = firstAgentId();
    for (let i = 0; i < 30; i++) practiceHobby(agentId, 'fish', 600 + i * 60);
    const level = getHobbyLevel(agentId, 'fish');
    expect(level).toBeGreaterThan(0);

    // A running loop is paused for the copy and resumed after it.
    vi.mocked(isTickLoopRunning).mockReturnValueOnce(true);
    const meta = await saveWorld('Before the storm');
    expect(stopTickLoopAndWait).toHaveBeenCalledTimes(1);
    expect(startTickLoop).toHaveBeenCalledTimes(1);

    expect(meta.name).toBe('Before the storm');
    expect(meta.kind).toBe('manual');
    expect(meta.id).toMatch(/^before-the-storm-\d{8}-\d{9}$/);
    expect(meta.residents).toEqual(['Saver 1', 'Saver 2', 'Saver 3', 'Saver 4']);
    expect(meta.seed).toBe('saves-test-seed');
    expect(meta.day).toBe(1);
    expect(meta.userVersion).toBe(userVersion());
    // Only the saves dir, and a self-contained file (no WAL leftovers).
    expect(fs.readdirSync(dir).sort()).toEqual([`${meta.id}.db`, `${meta.id}.json`]);
    expect(listSaves().map((s) => s.id)).toContain(meta.id);

    const before = dumpWorld();
    expect(before.sim_snapshots.length).toBeGreaterThan(0);

    mutateWorld();
    for (let i = 0; i < 30; i++) practiceHobby(agentId, 'fish', 5000 + i * 60);
    expect(getHobbyLevel(agentId, 'fish')).toBeGreaterThan(level);
    expect(dumpWorld()).not.toEqual(before);

    const loaded = await loadSave(meta.id);
    expect(loaded.id).toBe(meta.id);
    expect(dumpWorld()).toEqual(before);
    expect(getHobbyLevel(agentId, 'fish')).toBe(level);
    // A load always leaves the loop running, like a world replace.
    expect(startTickLoop).toHaveBeenCalled();
  });

  it('loads a save that predates some columns and tables', async () => {
    const meta = await saveWorld('Old format');
    const before = dumpWorld();

    // Make it look like an older build wrote it.
    const old = new Database(path.join(dir, `${meta.id}.db`));
    old.exec('ALTER TABLE world_state DROP COLUMN money_target_per_capita');
    old.exec('ALTER TABLE shared_knowledge DROP COLUMN revealed_at');
    old.exec('DROP TABLE gazette_issues');
    old.exec('DROP TABLE app_meta');
    old.close();

    mutateWorld();
    await loadSave(meta.id);

    const after = dumpWorld();
    expect(after.agents).toEqual(before.agents);
    expect(after.memories).toEqual(before.memories);
    expect(after.relationships).toEqual(before.relationships);
    expect(after.gazette_issues).toEqual([]);
    const world = sqlite.prepare('SELECT money_target_per_capita AS m, weather FROM world_state').get() as { m: number | null; weather: string };
    expect(world.m).toBeNull();
    expect(world.weather).toBe((before.world_state[0] as { weather: string }).weather);
    // No marker in the save: its vectors read as the legacy model (re-embedded).
    expect(sqlite.prepare("SELECT value FROM app_meta WHERE key = 'embedding_model'").get()).toBeUndefined();
  });

  it('runs the migrations an older save missed, as a boot on that file would', async () => {
    const meta = await saveWorld('Before the wage floor');
    // user_version 2: game-minute stamps, but from before the E5 wage floor (3).
    const old = new Database(path.join(dir, `${meta.id}.db`));
    old.pragma('user_version = 2');
    old.prepare('UPDATE economy SET salary = 5 WHERE agent_id = (SELECT min(id) FROM agents)').run();
    old.close();

    const liveVersion = userVersion();
    await loadSave(meta.id);

    expect(userVersion()).toBe(liveVersion);
    const { salary } = sqlite.prepare('SELECT salary FROM economy WHERE agent_id = (SELECT min(id) FROM agents)').get() as { salary: number };
    expect(salary).toBe(GAME_CONFIG.ECONOMY.WAGE_FLOOR);
  });

  it('refuses a save from a newer build without touching anything', async () => {
    const meta = await saveWorld('From the future');
    const file = path.join(dir, `${meta.id}.db`);
    const future = new Database(file);
    future.pragma(`user_version = ${userVersion() + 1}`);
    future.close();

    mutateWorld();
    const before = dumpWorld();
    vi.mocked(stopTickLoopAndWait).mockClear();

    await expect(loadSave(meta.id)).rejects.toThrow(SaveRejectedError);
    await expect(loadSave(meta.id)).rejects.toThrow(/newer version/);
    expect(dumpWorld()).toEqual(before);
    // Refused before the game was even paused.
    expect(stopTickLoopAndWait).not.toHaveBeenCalled();
  });

  it('a load that fails halfway leaves the current world exactly as it was', async () => {
    const meta = await saveWorld('Broken');
    // `agents` is copied late in the table order, after most tables were
    // already emptied and refilled — and this one can't go in: `name` is NOT
    // NULL in the live schema, and every other required column is missing.
    const broken = new Database(path.join(dir, `${meta.id}.db`));
    broken.exec('PRAGMA foreign_keys = OFF');
    broken.exec('DROP TABLE agents');
    broken.exec('CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT)');
    broken.exec('INSERT INTO agents (id, name) VALUES (1, NULL)');
    broken.close();

    mutateWorld();
    const before = dumpWorld({ ignoreCheckpointTime: true });
    const versionBefore = userVersion();

    await expect(loadSave(meta.id)).rejects.toThrow(/NOT NULL/);
    expect(dumpWorld({ ignoreCheckpointTime: true })).toEqual(before);
    expect(userVersion()).toBe(versionBefore);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM pragma_database_list WHERE name = 'll_save'").get()).toEqual({ n: 0 });
    // The game goes on with the world it had.
    expect(startTickLoop).toHaveBeenCalled();
  });

  it('autosaves keep the newest 3 and never prune manual saves', async () => {
    for (const s of listSaves()) await deleteSave(s.id);
    const manual = await saveWorld('Keep me');

    const autos = [];
    for (let day = 1; day <= 5; day++) autos.push(await autosave(day));
    expect(autos.every((a) => a !== null)).toBe(true);

    const saves = listSaves();
    expect(saves.filter((s) => s.kind === 'auto').map((s) => s.name)).toEqual([
      'Autosave — Day 5', 'Autosave — Day 4', 'Autosave — Day 3',
    ]);
    expect(saves.map((s) => s.id)).toContain(manual.id);
    // The pruned ones are gone from disk, not just from the list.
    for (const a of autos.slice(0, 2)) {
      expect(fs.existsSync(path.join(dir, `${a!.id}.db`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${a!.id}.json`))).toBe(false);
    }
    expect(await pruneAutosaves(3)).toEqual([]);
  });

  it('router: saves and lists, validates ids, and hands refusals back as BAD_REQUEST', async () => {
    const { savesRouter } = await import('../../routers/saves');
    const caller = savesRouter.createCaller({} as never);

    const meta = await caller.save({ name: 'Via the router' });
    expect((await caller.list()).map((s) => s.id)).toContain(meta.id);

    await expect(caller.load({ id: '../little-life' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.load({ id: 'no-such-save' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Save not found' });
    expect(await caller.delete({ id: meta.id })).toEqual({ deleted: true });
  });

  it('delete removes both files and rejects ids that could leave the saves dir', async () => {
    const meta = await saveWorld('Doomed');
    expect(await deleteSave(meta.id)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${meta.id}.db`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${meta.id}.json`))).toBe(false);
    expect(await deleteSave(meta.id)).toBe(false);

    expect(() => deleteSave('../little-life')).toThrow(/Invalid save id/);
    expect(() => deleteSave('..')).toThrow(/Invalid save id/);
    expect(() => loadSave('C:\\evil')).toThrow(/Invalid save id/);
  });
});
