/**
 * Round-6 read-only probe. Pure arithmetic reproductions of two suspected bugs,
 * using the project's real CONFIG values and the real starting agent roster.
 * Touches no DB and mutates no project source.
 */
import { CONFIG } from '../../server/lib/constants';
import { AGENT_SEEDS } from '../../server/data/agents';

// ── 1. Relationship decay grace period (relationships.ts:392-397) ────────────
const gracePeriodMs = CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
console.log('=== relationship decay ===');
console.log('gracePeriodMs =', gracePeriodMs, '=', gracePeriodMs / 3_600_000, 'REAL hours');
// last_interaction is Date.now() and is refreshed by proximity familiarity every
// tick and by every relationshipEvent. Show what the guard yields for plausible
// real elapsed times.
for (const realMinutes of [1, 60, 60 * 8, 60 * 24, 60 * 24 * 3 + 1]) {
  const elapsed = realMinutes * 60 * 1000;
  console.log(
    `  real elapsed ${String(realMinutes).padStart(5)} min -> decay runs? ${elapsed > gracePeriodMs}`,
  );
}
// Even when it does run, show the per-invocation magnitude at tick_speed 1.
for (const tickSpeed of [0.5, 1, 2, 4]) {
  const gameHoursElapsed = tickSpeed / 60;
  const daysSince = (gracePeriodMs + 1) / (24 * 60 * 60 * 1000);
  const decayStrength = Math.min(daysSince / CONFIG.RELATIONSHIPS.DECAY_MAX_STRENGTH_DAYS, 1);
  const dailyDecayRate = CONFIG.RELATIONSHIPS.DECAY_DAILY_RATE * decayStrength * (gameHoursElapsed / 24);
  console.log(`  tick_speed ${tickSpeed}: per-invocation decay = ${dailyDecayRate.toExponential(3)} points`);
}

// ── 2. old_age death trigger (lifeEventsEngine.ts:110-114) ───────────────────
console.log('\n=== old_age death trigger ===');
const roster = AGENT_SEEDS.map(a => ({ name: a.name, age: a.age }));
roster.sort((a, b) => b.age - a.age);

function survivalProbe(startAge: number): { thresholdTick: number; medianDeathTick: number } {
  const thresholdTick = Math.max(0, (80 - startAge) * 1440);
  // hazard per tick once simAge >= 80
  let logSurvive = 0;
  let tick = thresholdTick;
  let median = -1;
  while (tick < 5_000_000) {
    const simAge = startAge + Math.floor(tick / 1440);
    const p = 0.0001 * (simAge - 80);
    if (p > 0) logSurvive += Math.log(1 - p);
    if (median < 0 && Math.exp(logSurvive) < 0.5) median = tick;
    if (Math.exp(logSurvive) < 1e-4) break;
    tick++;
  }
  return { thresholdTick, medianDeathTick: median };
}

console.log('name                 age  tick@simAge80  medianDeathTick  medianDeath(real h)  medianDeath(game days @1x)');
for (const a of roster) {
  const { thresholdTick, medianDeathTick } = survivalProbe(a.age);
  console.log(
    a.name.padEnd(20),
    String(a.age).padStart(3),
    String(thresholdTick).padStart(14),
    String(medianDeathTick).padStart(16),
    (medianDeathTick / 3600).toFixed(1).padStart(20),
    (medianDeathTick / 1440).toFixed(1).padStart(26),
  );
}

// For comparison: what agingEngine thinks their age is at the same tick.
console.log('\nagingEngine age progression (112 game days per year):');
for (const tickSpeed of [1, 4]) {
  const ticks = 86_400;
  const gameDays = (ticks * tickSpeed) / 1440;
  console.log(
    `  tick_speed ${tickSpeed}: after ${ticks} ticks = ${gameDays} game days = +${Math.floor(gameDays / 112)} years from agingEngine,`,
    `but lifeEventsEngine adds +${Math.floor(ticks / 1440)} years`,
  );
}
