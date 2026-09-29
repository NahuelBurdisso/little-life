import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { eq, getTableName } from 'drizzle-orm';
import { db, sqlite, initSchema } from '../db';
import { agents, worldState } from '../db/schema';
import { ALL_TABLES } from '../db/worldTables';
import { isTickLoopRunning, startTickLoop, stopTickLoopAndWait } from '../engine/tick';
import { taskRunner } from '../ai/taskRunner';
import { memoryService } from './memory/instance';
import { saveWorldCaches } from '../engine/worldCaches';
import { resetWorldRuntime } from '../engine/worldRuntime';
import { endOrphanedLLMConversations } from '../engine/systems/conversations';
import { emitter } from '../engine/emitter';
import { CONFIG } from './constants';

// ─── Save slots ───────────────────────────────────────────────────────────────
// There is one world per DB file, and Restart / Reset to Wizard destroy it. A
// town takes hours of LLM time to grow its feuds and secrets, and the player had
// no way to keep a good one or to branch ("what if I reveal this?").
//
// A save is a complete copy of the DB file, made with SQLite's online backup
// (`sqlite.backup`), plus a sidecar JSON with what the Saves dialog lists. A
// whole-file copy rather than an export of the world tables, because it is the
// one format that cannot drift from the schema: every column any version wrote
// is in it, and `PRAGMA user_version` travels in its header.
//
// Loading goes the other way *inside the live DB* — ATTACH the save, and in one
// transaction replace every world table's rows with the save's. Swapping the DB
// file itself would have been simpler to write and impossible to do safely:
// `server/db` holds one process-wide connection that ~every module captured at
// import (plus prepared statements, TEMP triggers and a SQL function), and a
// failed swap halfway would leave no world at all. A transaction gives "the
// current world is untouched on any failure" for free.
//
// Only columns both sides have are copied, so a save from before a column was
// added still loads (the column takes its default), and the migrations + self
// heal of a normal boot (`initSchema`) run on the loaded rows inside the same
// transaction — a save from before the game-minute clock gets rebased exactly
// like an old DB file would at startup. A save from a *newer* build is refused:
// its rows may mean things this code does not know.
//
// Every file this module writes or deletes lives in the saves directory
// (`data/saves/` next to the DB); ids are validated before any path is built.

export type SaveKind = 'manual' | 'auto';

/**
 * A refusal the player should read (no town yet, a save from a newer build,
 * not a save at all) rather than a failure of the operation itself.
 */
export class SaveRejectedError extends Error {}

export interface SaveMeta {
  /** Sidecar format, for whoever reads these later. */
  format: 1;
  /** File stem: `<slug>-<timestamp>`. The .db and .json share it. */
  id: string;
  name: string;
  kind: SaveKind;
  /** Real time the save was taken (ms since epoch). */
  createdAt: number;
  day: number;
  season: string;
  hour: number;
  minute: number;
  /** Active residents, for the list ("Ada, Bram, Clara +10"). */
  residents: string[];
  /** Worldgen seed from the setup config; null for worlds built without one. */
  seed: string | null;
  /** `PRAGMA user_version` of the saved file (migration level of its rows). */
  userVersion: number;
  sizeBytes: number;
}

// ─── Where saves live ─────────────────────────────────────────────────────────

/**
 * `data/saves/` next to whichever DB the server runs on. Under vitest a temp
 * dir instead: the engine tests drive ticks, and nothing a test does may land
 * in the player's saves (tests also call `setSavesDir` with their own).
 */
function defaultSavesDir(): string {
  if (process.env.VITEST) return path.join(os.tmpdir(), `little-life-test-saves-${process.pid}`);
  const dbPath = process.env.DATABASE_PATH || './data/little-life.db';
  return path.resolve(path.dirname(dbPath), 'saves');
}

let savesDir = defaultSavesDir();

/** Point the module at another directory. For tests. */
export function setSavesDir(dir: string): void {
  savesDir = path.resolve(dir);
}

export function getSavesDir(): string {
  return savesDir;
}

/** Lowercase, digits and dashes: nothing that can climb out of the directory. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

function fileFor(id: string, ext: '.db' | '.json'): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid save id: ${id}`);
  const file = path.join(savesDir, id + ext);
  // Belt and braces over the regex: the file must sit directly in the dir.
  if (path.dirname(file) !== savesDir) throw new Error(`Invalid save id: ${id}`);
  return file;
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'save';
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function uniqueId(slug: string, ms: number): string {
  const base = `${slug}-${stamp(ms)}`;
  let id = base;
  for (let n = 2; fs.existsSync(fileFor(id, '.db')) || fs.existsSync(fileFor(id, '.json')); n++) id = `${base}-${n}`;
  return id;
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Save, load, delete and the autosave prune all run one at a time. A load
 * during a save would copy half a world into the backup; an autosave prune
 * during a load could delete the file being attached.
 */
let lock: Promise<unknown> = Promise.resolve();
function withSavesLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

let lastCreatedAt = 0;

/** How long a save/load waits for queued memories to reach the DB. */
const MEMORY_FLUSH_TIMEOUT_MS = 15_000;
/** Same cap `replaceWorld` gives in-flight LLM tasks before a world swap. */
const TASK_DRAIN_TIMEOUT_MS = 10_000;

function userVersion(conn: Database.Database, schema = 'main'): number {
  return conn.pragma(`${schema}.user_version`, { simple: true }) as number;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function readWorldInfo(): Pick<SaveMeta, 'day' | 'season' | 'hour' | 'minute' | 'residents' | 'seed'> {
  const world = db.select({ time: worldState.time, setup_config: worldState.setup_config }).from(worldState).limit(1).get();
  const residents = db.select({ name: agents.name }).from(agents).where(eq(agents.is_active, true)).all().map((a) => a.name);
  // The wizard placeholder (`resetToWizard`) has a world row but no town.
  if (!world || residents.length === 0) throw new SaveRejectedError('There is no town to save yet');
  const seed = (world.setup_config as { worldgen?: { seed?: unknown } } | null)?.worldgen?.seed;
  return {
    day: world.time.day,
    season: world.time.season,
    hour: world.time.hour,
    minute: world.time.minute,
    residents,
    seed: typeof seed === 'string' ? seed : null,
  };
}

/**
 * A backup of a WAL database is itself flagged WAL, so every later open of it
 * (the ATTACH of a load) would leave -wal/-shm files lying next to it. Rewrite
 * it as a self-contained rollback-journal file once, now. Returns its
 * user_version.
 */
function finalizeSaveFile(file: string): number {
  const conn = new Database(file, { fileMustExist: true });
  try {
    conn.pragma('journal_mode = DELETE');
    return userVersion(conn);
  } finally {
    conn.close();
  }
}

function removeSaveFiles(id: string): boolean {
  const dbFile = fileFor(id, '.db');
  let removed = false;
  for (const f of [dbFile, fileFor(id, '.json'), `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removed = true;
    }
  }
  return removed;
}

/**
 * Copy the current world into a new save. Pauses the tick loop for the
 * duration (resuming it only if it was running), so the copy holds whole ticks
 * and matches the in-memory state checkpointed with it.
 */
export function saveWorld(name: string, opts: { kind?: SaveKind } = {}): Promise<SaveMeta> {
  const kind = opts.kind ?? 'manual';
  const label = name.trim().slice(0, 80) || (kind === 'auto' ? 'Autosave' : 'Save');
  return withSavesLock(async () => {
    const wasRunning = isTickLoopRunning();
    await stopTickLoopAndWait();
    let id: string | null = null;
    try {
      const world = readWorldInfo();
      // Memories still waiting for their embeddings are not in the DB yet.
      if (!(await memoryService.flushPending(MEMORY_FLUSH_TIMEOUT_MS))) {
        console.warn('[saves] some queued memories were not written in time and are not in this save');
      }
      // Hobbies, favors, tension, drift baselines... live in memory; the
      // `sim_snapshots` rows are how they travel with the save.
      saveWorldCaches();

      fs.mkdirSync(savesDir, { recursive: true });
      // Strictly increasing, so "newest first" (the list, the autosave prune)
      // is never a tie between two saves taken in the same millisecond.
      const createdAt = Math.max(Date.now(), lastCreatedAt + 1);
      lastCreatedAt = createdAt;
      id = uniqueId(slugify(label), createdAt);
      const dbFile = fileFor(id, '.db');
      await sqlite.backup(dbFile);
      const fileVersion = finalizeSaveFile(dbFile);

      const meta: SaveMeta = {
        format: 1,
        id,
        name: label,
        kind,
        createdAt,
        ...world,
        userVersion: fileVersion,
        sizeBytes: fs.statSync(dbFile).size,
      };
      // Written last and atomically: `listSaves` only shows a save whose
      // sidecar exists, so a crash mid-backup leaves nothing half-listed.
      const metaFile = fileFor(id, '.json');
      fs.writeFileSync(`${metaFile}.tmp`, JSON.stringify(meta, null, 2));
      fs.renameSync(`${metaFile}.tmp`, metaFile);
      return meta;
    } catch (err) {
      if (id) {
        try { removeSaveFiles(id); } catch { /* best effort */ }
      }
      throw err;
    } finally {
      if (wasRunning) startTickLoop();
    }
  });
}

// ─── List / delete ────────────────────────────────────────────────────────────

function readMeta(id: string): SaveMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(fileFor(id, '.json'), 'utf8')) as SaveMeta;
    if (meta.id !== id || typeof meta.createdAt !== 'number' || typeof meta.name !== 'string') return null;
    if (!fs.existsSync(fileFor(id, '.db'))) return null;
    return { ...meta, residents: Array.isArray(meta.residents) ? meta.residents : [] };
  } catch {
    return null;
  }
}

/** Every save with a readable sidecar and its DB file, newest first. */
export function listSaves(): SaveMeta[] {
  if (!fs.existsSync(savesDir)) return [];
  const saves: SaveMeta[] = [];
  for (const f of fs.readdirSync(savesDir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const meta = readMeta(id);
    if (meta) saves.push(meta);
  }
  return saves.sort((a, b) => b.createdAt - a.createdAt);
}

/** Delete one save's files. Only ever touches the saves directory. */
export function deleteSave(id: string): Promise<boolean> {
  fileFor(id, '.db'); // validate before queueing
  return withSavesLock(async () => removeSaveFiles(id));
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/** Tables a load replaces: the world's, plus `app_meta`. */
function copiedTables(): string[] {
  // `app_meta` records which embedding model made the stored vectors. The
  // save's vectors come with the save, so its marker must too: a save made
  // under another model then gets re-embedded by the day-change backfill
  // instead of being ranked against incomparable query vectors. A save with
  // no marker reads as the legacy model, which is the same backfill's rule.
  return [...ALL_TABLES.map((t) => getTableName(t)), 'app_meta'];
}

function columnsOf(schema: string, table: string): string[] {
  return (sqlite.pragma(`${schema}.table_info("${table}")`) as Array<{ name: string }>).map((c) => c.name);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Check a save before anything is stopped or touched: readable, a Little Life
 * world, and not from a newer build.
 */
function precheck(file: string): void {
  let conn: Database.Database;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new SaveRejectedError(`Save file can't be opened: ${(err as Error).message}`);
  }
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    if (!tables.has('world_state') || !tables.has('agents')) throw new SaveRejectedError('Not a Little Life save');
    const saved = userVersion(conn);
    const live = userVersion(sqlite);
    if (saved > live) {
      throw new SaveRejectedError(`This save comes from a newer version of Little Life (data version ${saved}, this one reads up to ${live})`);
    }
  } catch (err) {
    if (err instanceof SaveRejectedError) throw err;
    throw new SaveRejectedError(`Save file is unreadable: ${(err as Error).message}`);
  } finally {
    conn.close();
  }
}

const SAVE_SCHEMA = 'll_save';

/**
 * Replace the live world's rows with the save's. Synchronous and all-or-nothing:
 * on any throw the transaction rolls back and the DB holds the current world,
 * untouched, user_version included.
 */
function copySaveIntoLiveDb(file: string): void {
  sqlite.prepare(`ATTACH DATABASE ? AS ${SAVE_SCHEMA}`).run(file);
  try {
    // Re-checked on the attached file itself — it is what gets copied.
    const saved = userVersion(sqlite, SAVE_SCHEMA);
    const live = userVersion(sqlite);
    if (saved > live) throw new SaveRejectedError(`This save comes from a newer version of Little Life (data version ${saved} > ${live})`);
    const saveTables = new Set(
      (sqlite.prepare(`SELECT name FROM ${SAVE_SCHEMA}.sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((r) => r.name),
    );

    // `foreign_keys` is a no-op inside a transaction, so it is switched around
    // it. Off because the copy goes table by table in whatever order, and the
    // save's rows are already a consistent world; `defer_foreign_keys` (what
    // `replaceWorld` uses) would instead fail the whole load at COMMIT over any
    // dangling reference an old world happened to carry.
    sqlite.pragma('foreign_keys = OFF');
    try {
      sqlite.transaction(() => {
        for (const table of copiedTables()) {
          sqlite.exec(`DELETE FROM main.${q(table)}`);
          // A table the save predates stays empty (gazette, sim snapshots...).
          if (!saveTables.has(table)) continue;
          const theirs = new Set(columnsOf(SAVE_SCHEMA, table));
          const shared = columnsOf('main', table).filter((c) => theirs.has(c));
          if (shared.length === 0) continue;
          const cols = shared.map(q).join(', ');
          sqlite.exec(`INSERT INTO main.${q(table)} (${cols}) SELECT ${cols} FROM ${SAVE_SCHEMA}.${q(table)}`);
        }
        // The rows are at the save's migration level now, so the DB must say
        // so; `initSchema` then runs exactly what a boot on that file would —
        // the one-shot migrations the save missed, the additive backfills and
        // the future-stamp self heal. Inside the transaction: a migration that
        // throws rolls the whole load back.
        sqlite.pragma(`user_version = ${saved}`);
        initSchema();

        const violations = sqlite.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          console.warn(`[saves] loaded world has ${violations.length} dangling reference(s); kept as saved`);
        }
      })();
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }
  } finally {
    sqlite.exec(`DETACH DATABASE ${SAVE_SCHEMA}`);
  }
}

/**
 * Replace the running world with a save. Unsaved progress since the last save
 * is lost — the UI confirms first. On failure the current world is left as it
 * was and the error is rethrown; the tick loop restarts either way.
 */
export function loadSave(id: string): Promise<SaveMeta> {
  const file = fileFor(id, '.db');
  return withSavesLock(async () => {
    if (!fs.existsSync(file)) throw new SaveRejectedError('Save not found');
    const meta = readMeta(id);
    precheck(file);

    // The same wind-down as `replaceWorld` (routers/setup.ts): no tick and no
    // LLM task may write while the tables are swapped.
    await stopTickLoopAndWait();
    await Promise.race([
      taskRunner.drain(),
      new Promise((resolve) => setTimeout(resolve, TASK_DRAIN_TIMEOUT_MS)),
    ]);
    // Written while the outgoing world is still in the DB, so a failed load
    // does not cost it the memories that were queued.
    await memoryService.flushPending(MEMORY_FLUSH_TIMEOUT_MS);
    taskRunner.resetSlots();
    // Checkpoint the outgoing world: on a rolled-back load this is what
    // `resetWorldRuntime` restores its hobbies, favors, tension... from.
    saveWorldCaches();

    try {
      copySaveIntoLiveDb(file);
    } finally {
      // Both paths, as in `replaceWorld`: drop every cache of the world that
      // was running, then rebuild from whichever world the DB now holds (the
      // save's sim_snapshots rows restore its in-memory state). Wrapped so a
      // throw here can never skip the loop restart and the client signal.
      try {
        resetWorldRuntime();
        // The save's scheduler lists the LLM conversations that were running
        // when it was taken; no turn chain exists for them in this process
        // (and resetSlots cancelled the outgoing world's). End them and free
        // their participants, as a boot does.
        endOrphanedLLMConversations();
      } catch (err) {
        console.error('[saves] cache reset after load failed (tick loop still restarts):', err);
      }
      // Unconditional, like `replaceWorld`: `gameTick` no-ops on a paused world.
      startTickLoop();
      emitter.markAllDirty();
      emitter.flush();
    }

    return meta ?? { ...EMPTY_META, id };
  });
}

/** For a save whose sidecar went missing: the file still loads. */
const EMPTY_META: SaveMeta = {
  format: 1, id: '', name: 'Save', kind: 'manual', createdAt: 0, day: 0, season: '',
  hour: 0, minute: 0, residents: [], seed: null, userVersion: 0, sizeBytes: 0,
};

// ─── Autosave ─────────────────────────────────────────────────────────────────

/** Delete autosaves beyond the newest `keep`. Manual saves are never touched. */
export function pruneAutosaves(keep: number = CONFIG.SAVES.AUTOSAVE_KEEP): Promise<string[]> {
  return withSavesLock(async () => {
    const stale = listSaves().filter((s) => s.kind === 'auto').slice(Math.max(0, keep));
    for (const s of stale) removeSaveFiles(s.id);
    return stale.map((s) => s.id);
  });
}

/**
 * The day-change autosave (engine/tick.ts). Never throws: a failed autosave is
 * logged and the game goes on.
 */
export async function autosave(day: number): Promise<SaveMeta | null> {
  try {
    const meta = await saveWorld(`Autosave — Day ${day}`, { kind: 'auto' });
    await pruneAutosaves();
    return meta;
  } catch (err) {
    console.warn('[saves] autosave failed:', (err as Error).message);
    return null;
  }
}
