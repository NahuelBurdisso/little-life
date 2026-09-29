import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NightSkipController, type AgentSnap, type NightSkipPorts } from '../nightSkip';
import { NIGHT_SKIP } from '../../lib/nightSkip';

/** A world at `hour:minute` on day 2. */
function world(hour: number, minute = 0, over: { tick_speed?: number; is_paused?: boolean } = {}) {
  return { time: { day: 2, hour, minute }, tick_speed: over.tick_speed ?? 2, is_paused: over.is_paused ?? false };
}

const sleeper = (id: number): AgentSnap => ({ id, asleep: true, ignored: false });
const up = (id: number): AgentSnap => ({ id, asleep: false, ignored: false });

function makePorts() {
  const state = {
    agents: [sleeper(1), sleeper(2), sleeper(3)] as AgentSnap[],
    important: 0,
    backlog: 0,
    speed: 2,
    saved: undefined as number | null | undefined,
  };
  const ports: NightSkipPorts = {
    agents: () => state.agents,
    latestActivityId: () => 100,
    importantEventsSince: vi.fn((_id: number, _since: number) => state.important),
    llmBacklog: () => state.backlog,
    writeSpeed: vi.fn((s: number) => { state.speed = s; }),
    saveRestoreSpeed: vi.fn((s: number | null) => { state.saved = s; }),
    onChange: vi.fn(),
  };
  return { ports, state };
}

describe('NightSkipController', () => {
  let h: ReturnType<typeof makePorts>;
  let ctl: NightSkipController;
  beforeEach(() => {
    h = makePorts();
    ctl = new NightSkipController(h.ports);
  });

  it('starts at night, remembers the player speed, and raises the tick speed', () => {
    expect(ctl.start(world(23, 0))).toEqual({ ok: true });
    expect(ctl.isActive()).toBe(true);
    expect(ctl.restoreSpeed()).toBe(2);
    expect(h.state.saved).toBe(2);
    expect(h.state.speed).toBe(NIGHT_SKIP.SPEED);
    // 23:00 on day 2 -> 06:00 on day 3.
    expect(ctl.status()).toMatchObject({ active: true, startMinute: 2 * 1440 + 23 * 60, targetMinute: 3 * 1440 + 6 * 60 });
  });

  it('refuses in daytime, when paused and when already running', () => {
    expect(ctl.start(world(14))).toEqual({ ok: false, reason: expect.stringContaining('23:00') });
    expect(ctl.start(world(1, 0, { is_paused: true }))).toEqual({ ok: false, reason: expect.stringContaining('Resume') });
    ctl.start(world(1));
    expect(ctl.start(world(1))).toEqual({ ok: false, reason: expect.stringContaining('Already') });
  });

  it('is transparent when no skip runs', () => {
    expect(ctl.beforeTick(world(12, 0, { tick_speed: 4 }))).toBe(4);
    expect(h.ports.writeSpeed).not.toHaveBeenCalled();
  });

  it('runs at skip speed, landing exactly on 06:00 and then handing the speed back', () => {
    ctl.start(world(4, 30)); // 90 minutes to go
    (h.ports.writeSpeed as ReturnType<typeof vi.fn>).mockClear();

    // 04:30 -> 05:00 -> 05:30 -> 06:00: three 30-minute ticks.
    expect(ctl.beforeTick(world(4, 30, { tick_speed: 30 }))).toBe(30);
    expect(ctl.beforeTick(world(5, 0, { tick_speed: 30 }))).toBe(30);
    expect(ctl.beforeTick(world(5, 30, { tick_speed: 30 }))).toBe(30);
    // The clock is on 06:00: this tick runs at the player's speed again.
    expect(ctl.beforeTick(world(6, 0, { tick_speed: 30 }))).toBe(2);
    expect(ctl.isActive()).toBe(false);
    expect(h.state.speed).toBe(2);
    expect(h.state.saved).toBeNull();
    expect(ctl.status().lastStop).toEqual({ reason: 'morning', seq: 1 });
  });

  it('shortens the final step when the target is not a whole number of steps away', () => {
    ctl.start(world(5, 10)); // 50 minutes: 30 + 20
    expect(ctl.beforeTick(world(5, 10, { tick_speed: 30 }))).toBe(30);
    expect(ctl.beforeTick(world(5, 40, { tick_speed: 30 }))).toBe(20);
    expect(h.state.speed).toBe(20);
  });

  it('stops on an important event and restores the speed', () => {
    ctl.start(world(1));
    h.state.important = 1;
    expect(ctl.beforeTick(world(2, 0, { tick_speed: 30 }))).toBe(2);
    expect(ctl.status().lastStop?.reason).toBe('event');
    expect(h.state.speed).toBe(2);
  });

  it('stops when several sleepers wake in the small hours, not for one, nor for people who were up all along', () => {
    h.state.agents = [sleeper(1), sleeper(2), sleeper(3), sleeper(4), up(5)];
    ctl.start(world(0, 30));
    expect(ctl.beforeTick(world(1, 0, { tick_speed: 30 }))).toBe(30);
    h.state.agents = [sleeper(1), up(2), sleeper(3), sleeper(4), up(5)]; // a lone night walker
    expect(ctl.beforeTick(world(1, 30, { tick_speed: 30 }))).toBe(30);
    h.state.agents = [sleeper(1), up(2), up(3), sleeper(4), up(5)];
    expect(ctl.beforeTick(world(2, 0, { tick_speed: 30 }))).toBe(2);
    expect(ctl.status().lastStop).toEqual({ reason: 'woke', seq: 1, agentIds: [2, 3] });
  });

  it('a prisoner who is awake does not count as anyone waking', () => {
    h.state.agents = [sleeper(1), { id: 2, asleep: false, ignored: true }];
    ctl.start(world(1));
    expect(ctl.beforeTick(world(1, 30, { tick_speed: 30 }))).toBe(30);
  });

  it('slows to the throttle speed while the LLM queue is backed up', () => {
    ctl.start(world(0, 0));
    h.state.backlog = NIGHT_SKIP.LLM_BACKLOG_LIMIT + 3;
    expect(ctl.beforeTick(world(0, 30, { tick_speed: 30 }))).toBe(NIGHT_SKIP.THROTTLE_SPEED);
    h.state.backlog = 0;
    expect(ctl.beforeTick(world(0, 34, { tick_speed: 4 }))).toBe(30);
  });

  it('cancel with restore gives the speed back; without it, the player choice stands', () => {
    ctl.start(world(1));
    expect(ctl.cancel({ restore: true })).toBe(true);
    expect(h.state.speed).toBe(2);
    expect(ctl.status().lastStop?.reason).toBe('cancelled');

    ctl.start(world(1, 0, { tick_speed: 2 }));
    (h.ports.writeSpeed as ReturnType<typeof vi.fn>).mockClear();
    expect(ctl.cancel({ restore: false })).toBe(true);
    expect(h.ports.writeSpeed).not.toHaveBeenCalled();
    expect(h.state.saved).toBeNull();
  });

  it('cancel with nothing running says so', () => {
    expect(ctl.cancel()).toBe(false);
  });

  it('a replaced world drops the run without touching the new world speed', () => {
    ctl.start(world(1));
    (h.ports.writeSpeed as ReturnType<typeof vi.fn>).mockClear();
    ctl.reset();
    expect(ctl.isActive()).toBe(false);
    expect(h.ports.writeSpeed).not.toHaveBeenCalled();
    expect(ctl.status().lastStop?.reason).toBe('world_replaced');
  });

  it('notifies on start and on stop, but not on every tick', () => {
    ctl.start(world(1));
    ctl.beforeTick(world(1, 30, { tick_speed: 30 }));
    ctl.beforeTick(world(2, 0, { tick_speed: 30 }));
    expect(h.ports.onChange).toHaveBeenCalledTimes(1);
    ctl.cancel();
    expect(h.ports.onChange).toHaveBeenCalledTimes(2);
  });
});
