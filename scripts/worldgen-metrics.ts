/**
 * Town-quality metrics for the procedural generator, grid vs organic, over many
 * seeds. Pure worldgen — no DB, no server — so it is safe to run any time:
 *
 *   npx tsx scripts/worldgen-metrics.ts                 # 200 seeds, 13 and 30 agents
 *   npx tsx scripts/worldgen-metrics.ts --seeds 60 --agents 5,13,30
 *   npx tsx scripts/worldgen-metrics.ts --prefix probe  # a disjoint seed window
 *   npx tsx scripts/worldgen-metrics.ts --styles organic --w2 ""   # organic only, skip W2
 *
 * "Door distance" is the Manhattan distance from a location's entry tile to the
 * nearest road tile, the same measure `organic.test.ts` and `layout.test.ts`
 * assert on (near = ≤ 2 tiles, far = > 6). Public = every location that is not
 * a home or a derived outdoor plot.
 *
 * The last block is W2 from docs/STATUS.md: a fixed 56×43 custom map with many
 * agents, where the pipeline may not grow the map and a town that does not fit
 * fails outright (`[homes] not enough spots`).
 */
import { generateWorld } from '../server/lib/worldgen/pipeline';
import { buildRoadDistance } from '../server/lib/worldgen/stages/roadDistance';
import { dimensionsStage } from '../server/lib/worldgen/stages/dimensions';
import { makeRng } from '../server/lib/worldgen/rng';
import type { GenResult } from '../server/lib/worldgen';
import type { LayoutStyle, WorldGenConfig } from '../server/lib/worldgen/config';

const TILE = 32;
const OUTDOOR = new Set(['mainstreet', 'alley', 'market_square', 'farmyard']);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const SEEDS = Number(arg('seeds', '200'));
const AGENTS = arg('agents', '13,30').split(',').map(Number);
const PREFIX = arg('prefix', 'metrics');
const W2_AGENTS = arg('w2', '30,32').split(',').filter(Boolean).map(Number);
const STYLES = arg('styles', 'grid,organic').split(',') as LayoutStyle[];

// generateWorld logs one line per world.
const log = console.log;
console.log = () => {};
console.warn = () => {};

interface Tally {
  pub: number; pubNear: number; pubFar: number;
  home: number; homeNear: number; homeFar: number;
  alley: number; farmyard: number; market: number; grown: number; worlds: number;
  ms: number; roadTiles: number;
}

function tally(style: LayoutStyle, agents: number): Tally {
  const t: Tally = {
    pub: 0, pubNear: 0, pubFar: 0, home: 0, homeNear: 0, homeFar: 0,
    alley: 0, farmyard: 0, market: 0, grown: 0, worlds: 0, ms: 0, roadTiles: 0,
  };
  // The size the pipeline starts from; anything else means it had to grow the map.
  const d0 = dimensionsStage.run({} as never, makeRng(0), { sizeTier: 'auto', overrides: {} }, agents, {}).dimensions;
  const base = { w: d0.width, h: d0.height };
  for (let i = 0; i < SEEDS; i++) {
    const cfg: WorldGenConfig = { sizeTier: 'auto', overrides: {}, seed: `${PREFIX}-${agents}-${i}`, layoutStyle: style };
    const started = performance.now();
    const r: GenResult = generateWorld(cfg, agents);
    t.ms += performance.now() - started;
    t.worlds++;
    t.roadTiles += r.roads.length;
    const { width, height } = r.dimensions;
    if (width !== base.w || height !== base.h) t.grown++;
    const dist = buildRoadDistance(width, height, r.roads);
    const types = new Set(r.locations.map((l) => l.type));
    if (types.has('alley')) t.alley++;
    if (types.has('farmyard')) t.farmyard++;
    if (types.has('market_square')) t.market++;
    for (const l of r.locations) {
      if (OUTDOOR.has(l.type)) continue;
      const d = dist[Math.floor(l.entry_point.y / TILE) * width + Math.floor(l.entry_point.x / TILE)];
      if (l.type === 'home') {
        t.home++; if (d <= 2) t.homeNear++; if (d > 6) t.homeFar++;
      } else {
        t.pub++; if (d <= 2) t.pubNear++; if (d > 6) t.pubFar++;
      }
    }
  }
  return t;
}

const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`.padStart(6);

log(`seeds=${SEEDS} prefix=${PREFIX}`);
log('style    agents  pubNear pubFar  homeNear homeFar  alley  farmyd market  grown  roads  ms/world');
for (const agents of AGENTS) {
  for (const style of STYLES) {
    const t = tally(style, agents);
    log(
      `${style.padEnd(8)} ${String(agents).padStart(6)}  ${pct(t.pubNear, t.pub)} ${pct(t.pubFar, t.pub)}  ` +
      `${pct(t.homeNear, t.home)}   ${pct(t.homeFar, t.home)}  ${pct(t.alley, t.worlds)} ${pct(t.farmyard, t.worlds)} ` +
      `${pct(t.market, t.worlds)} ${String(t.grown).padStart(5)}  ${String(Math.round(t.roadTiles / t.worlds)).padStart(5)}  ` +
      `${(t.ms / t.worlds).toFixed(1)}`,
    );
  }
}

log('\nW2: custom 56×43, failures / seeds');
for (const agents of W2_AGENTS) {
  for (const style of STYLES) {
    let fail = 0;
    const reasons = new Map<string, number>();
    for (let i = 0; i < SEEDS; i++) {
      try {
        generateWorld({
          sizeTier: 'custom', customDimensions: { width: 56, height: 43 }, overrides: {},
          seed: `${PREFIX}-w2-${agents}-${i}`, layoutStyle: style,
        }, agents);
      } catch (e) {
        fail++;
        const why = String((e as Error).message).replace(/\d+/g, 'N');
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
      }
    }
    log(`${style.padEnd(8)} ${String(agents).padStart(3)} agents: ${fail}/${SEEDS}  ${[...reasons].map(([k, v]) => `${v}× ${k}`).join('; ')}`);
  }
}
