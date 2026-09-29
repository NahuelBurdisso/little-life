/**
 * The "Skip to morning" controller: owns the state of a running skip and, at
 * the top of every tick, decides the speed that tick runs at (or ends the skip).
 * The rules themselves are pure and live in lib/nightSkip.ts.
 *
 * How it drives the sim: the skip raises `world_state.tick_speed` (game minutes
 * per tick) instead of touching the loop's interval. Everything that converts
 * between game minutes and wall time (LLM turn budgets, conversation cooldowns,
 * planning backoffs, the client's "x minutes ago") is defined in terms of
 * `tick_speed`, so a higher value keeps them mutually consistent, where ticking
 * faster at the same speed would leave every wall-clock window measuring a
 * different game duration than it thinks.
 *
 * The speed to give back is persisted in `app_meta`: the skip leaves tick_speed
 * at 30 in the DB, and a server that died mid-skip would otherwise come back
 * running the town at 30x with nobody able to say why (`recoverInterruptedSkip`).
 *
 * I/O goes through `NightSkipPorts` so the state machine is tested without a DB.
 */
import { db, sqlite } from '../db';
import { activityLog, agents, worldEvents, worldState } from '../db/schema';
import { and, eq, gt, gte, inArray, desc, sql } from 'drizzle-orm';
import { emitter } from './emitter';
import { getAgentStates } from '../lib/states';
import { getLLMStats } from '../ai/llmSemaphore';
import { gameMinutes } from '../lib/gameClock';
import {
  canSkipNight, decideSkipStep, DISRUPTIVE_EVENT_TYPES, minutesUntilMorning, NIGHT_SKIP,
  type SkipAgent, type SkipRun, type SkipStopReason,
} from '../lib/nightSkip';

export const NIGHT_SKIP_CHANNEL = 'world.nightSkip';
const META_KEY = 'night_skip_restore_speed';

export interface AgentSnap extends SkipAgent {
  id: number;
}

export interface NightSkipPorts {
  agents(): AgentSnap[];
  /** Newest activity_log id, the watermark "since the skip began" counts from. */
  latestActivityId(): number;
  /**
   * Things that should end a skip since it began: severe drama rows after
   * `activityId` and disruptive world events started at or after `sinceMinute`.
   */
  importantEventsSince(activityId: number, sinceMinute: number): number;
  llmBacklog(): number;
  writeSpeed(speed: number): void;
  /** Remember the speed to restore across a crash; null forgets it. */
  saveRestoreSpeed(speed: number | null): void;
  onChange(): void;
}

export interface NightSkipStatus {
  active: boolean;
  /** Absolute game minute the skip ends at, or null. */
  targetMinute: number | null;
  startMinute: number | null;
  /** How the most recent skip ended; `seq` grows with each so a client can react once. */
  lastStop: { reason: SkipStopReason; seq: number; agentIds?: number[] } | null;
}

interface WorldBits {
  time: { day: number; hour: number; minute: number };
  tick_speed: number;
  is_paused: boolean;
}

export class NightSkipController {
  private run: (SkipRun & { activityWatermark: number }) | null = null;
  private lastStop: { reason: SkipStopReason; seq: number; agentIds?: number[] } | null = null;

  constructor(private readonly ports: NightSkipPorts) {}

  isActive(): boolean {
    return this.run !== null;
  }

  /** The speed a running skip will hand back, or null when none runs. */
  restoreSpeed(): number | null {
    return this.run?.baseSpeed ?? null;
  }

  status(): NightSkipStatus {
    return {
      active: this.run !== null,
      targetMinute: this.run?.targetMinute ?? null,
      startMinute: this.run?.startMinute ?? null,
      lastStop: this.lastStop,
    };
  }

  /** Begin a skip if the rules allow it now. */
  start(world: WorldBits): { ok: true } | { ok: false; reason: string } {
    const snaps = this.ports.agents();
    const verdict = canSkipNight({
      hour: world.time.hour,
      paused: world.is_paused,
      active: this.run !== null,
      agents: snaps,
    });
    if (!verdict.ok) return verdict;

    const nowMinute = gameMinutes(world.time);
    const remaining = minutesUntilMorning(world.time.hour, world.time.minute);
    this.run = {
      targetMinute: nowMinute + remaining,
      startMinute: nowMinute,
      baseSpeed: world.tick_speed,
      sleepersAtStart: snaps.filter((a) => a.asleep && !a.ignored).map((a) => a.id),
      ticks: 0,
      activityWatermark: this.ports.latestActivityId(),
    };
    this.ports.saveRestoreSpeed(world.tick_speed);
    this.ports.writeSpeed(Math.min(NIGHT_SKIP.SPEED, remaining));
    this.ports.onChange();
    return { ok: true };
  }

  /**
   * Called at the top of every tick, before the clock advances. Returns the
   * `tick_speed` this tick must run at: the world's own when no skip runs, the
   * skip's pace while one does, or the restored base speed on the tick that
   * ends it.
   */
  beforeTick(world: WorldBits): number {
    const run = this.run;
    if (!run) return world.tick_speed;

    const snaps = this.ports.agents();
    const step = decideSkipStep(run, {
      nowMinute: gameMinutes(world.time),
      hour: world.time.hour,
      asleepIds: snaps.filter((a) => a.asleep && !a.ignored).map((a) => a.id),
      liveIds: snaps.filter((a) => !a.ignored).map((a) => a.id),
      importantEvents: this.ports.importantEventsSince(run.activityWatermark, run.startMinute),
      llmBacklog: this.ports.llmBacklog(),
    });

    if (step.kind === 'stop') {
      this.finish(step.reason, true, step.agentIds);
      return run.baseSpeed;
    }
    run.ticks++;
    if (step.speed !== world.tick_speed) this.ports.writeSpeed(step.speed);
    return step.speed;
  }

  /**
   * End a running skip. `restore` false when the player has just chosen a speed
   * themselves (change_speed): theirs stands and the old one must not overwrite it.
   */
  cancel(opts: { restore: boolean; reason?: SkipStopReason } = { restore: true }): boolean {
    if (!this.run) return false;
    this.finish(opts.reason ?? 'cancelled', opts.restore);
    return true;
  }

  private finish(reason: SkipStopReason, restore: boolean, agentIds?: number[]): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (restore) this.ports.writeSpeed(run.baseSpeed);
    this.ports.saveRestoreSpeed(null);
    this.lastStop = { reason, seq: (this.lastStop?.seq ?? 0) + 1, ...(agentIds?.length ? { agentIds } : {}) };
    this.ports.onChange();
  }

  /** World replaced: the run belongs to a town that no longer exists. */
  reset(): void {
    if (!this.run) return;
    this.run = null;
    this.ports.saveRestoreSpeed(null);
    this.lastStop = { reason: 'world_replaced', seq: (this.lastStop?.seq ?? 0) + 1 };
    this.ports.onChange();
  }
}

// ─── Real ports ───────────────────────────────────────────────────────────────

const dbPorts: NightSkipPorts = {
  agents() {
    const rows = db.select({ id: agents.id, action: agents.current_action })
      .from(agents).where(eq(agents.is_active, true)).all();
    return rows.map((r) => ({
      id: r.id,
      asleep: (r.action as { type?: string } | null)?.type === 'sleeping',
      // A prisoner sits awake in the cell all night and must not veto the skip
      // or count as someone who "woke up".
      ignored: getAgentStates(r.id).includes('arrested'),
    }));
  },

  latestActivityId() {
    return db.select({ id: activityLog.id }).from(activityLog).orderBy(desc(activityLog.id)).limit(1).get()?.id ?? 0;
  },

  importantEventsSince(activityId, sinceMinute) {
    const drama = db.select({ n: sql<number>`count(*)` }).from(activityLog)
      .where(and(
        gt(activityLog.id, activityId),
        eq(activityLog.category, 'drama'),
        gte(activityLog.importance, NIGHT_SKIP.STOP_MIN_IMPORTANCE),
      )).get()?.n ?? 0;
    // Events are stamped in game minutes; ones the player started themselves
    // (before this button was pressed) are not "new".
    const events = db.select({ n: sql<number>`count(*)` }).from(worldEvents)
      .where(and(
        gte(worldEvents.started_at, sinceMinute),
        inArray(worldEvents.type, [...DISRUPTIVE_EVENT_TYPES]),
      )).get()?.n ?? 0;
    return drama + events;
  },

  llmBacklog() {
    const w = getLLMStats().waitingByPriority;
    return w.critical + w.normal;
  },

  writeSpeed(speed) {
    db.update(worldState).set({ tick_speed: speed }).run();
  },

  saveRestoreSpeed(speed) {
    try {
      if (speed == null) sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(META_KEY);
      else sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, String(speed));
    } catch { /* a fresh DB without app_meta: the skip still works, only crash recovery is lost */ }
  },

  onChange() {
    emitter.markDirty(NIGHT_SKIP_CHANNEL);
    emitter.flushChannel(NIGHT_SKIP_CHANNEL);
  },
};

export const nightSkip = new NightSkipController(dbPorts);

/**
 * Boot-time repair: if the previous process died mid-skip, tick_speed is still
 * the skip's and the remembered base speed is in app_meta. Put it back.
 * Never throws; a fresh DB has no rows.
 */
export function recoverInterruptedSkip(): number | null {
  try {
    const row = sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
    if (!row) return null;
    const speed = Number(row.value);
    sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(META_KEY);
    if (!Number.isFinite(speed) || speed <= 0) return null;
    db.update(worldState).set({ tick_speed: speed }).run();
    return speed;
  } catch {
    return null;
  }
}
