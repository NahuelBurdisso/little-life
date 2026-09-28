/**
 * Verification harness for the worldgen remediation pass.
 * Measures: border violations, seed variety, venue presence, centrality.
 * Run: npx tsx docs/scratch/worldgen-verify.ts
 */
import { generateWorld } from '../../server/lib/worldgen';

const SEEDS = Array.from({ length: 30 }, (_, i) => `s${i}`);
const AGENTS = 13;
const BORDER = 2;

const present = new Map<string, number>();
const positions = new Map<string, Set<string>>();
let borderViolations = 0;
const violatingSeeds = new Set<string>();
const distFromCentre = new Map<string, number[]>();

for (const seed of SEEDS) {
  const w = generateWorld({ sizeTier: 'auto', overrides: {}, seed } as any, AGENTS, {} as any);
  const { width, height } = w.dimensions;

  for (const loc of w.locations) {
    const tx = loc.position.x / 32;
    const ty = loc.position.y / 32;
    const tw = loc.position.width / 32;
    const th = loc.position.height / 32;

    present.set(loc.type, (present.get(loc.type) ?? 0) + 1);

    if (!positions.has(loc.type)) positions.set(loc.type, new Set());
    positions.get(loc.type)!.add(`${tx},${ty}`);

    if (loc.type !== 'mainstreet') {
      if (tx < BORDER || ty < BORDER || tx + tw > width - BORDER || ty + th > height - BORDER) {
        borderViolations++;
        violatingSeeds.add(seed);
      }
    }

    const cx = tx + tw / 2;
    const cy = ty + th / 2;
    const d = Math.hypot(cx - width / 2, cy - height / 2);
    if (!distFromCentre.has(loc.type)) distFromCentre.set(loc.type, []);
    distFromCentre.get(loc.type)!.push(d);
  }
}

console.log(`\n=== BORDER (< ${BORDER} tiles from edge) ===`);
console.log(`violations: ${borderViolations} across ${violatingSeeds.size}/${SEEDS.length} seeds`);

console.log(`\n=== VENUE PRESENCE (out of ${SEEDS.length} seeds) ===`);
for (const [type, n] of [...present].sort((a, b) => a[1] - b[1])) {
  console.log(`  ${type.padEnd(16)} ${n}`);
}

console.log(`\n=== VARIETY (distinct origins / ${SEEDS.length} seeds) ===`);
for (const [type, set] of [...positions].sort((a, b) => a[1].size - b[1].size)) {
  console.log(`  ${type.padEnd(16)} ${set.size}`);
}

console.log(`\n=== MEAN DISTANCE FROM MAP CENTRE (tiles) ===`);
const means = [...distFromCentre].map(([t, ds]) => [t, ds.reduce((a, b) => a + b, 0) / ds.length] as const);
for (const [type, mean] of means.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(16)} ${mean.toFixed(1)}`);
}

// ─── Entry-point walkability + overlap ────────────────────────────────────────
let blockedEntries = 0;
let unreachable = 0;
let overlaps = 0;
const blockedByType = new Map<string, number>();

for (const seed of SEEDS) {
  const w = generateWorld({ sizeTier: 'auto', overrides: {}, seed } as any, AGENTS, {} as any);
  const { width, height } = w.dimensions;
  const grid = w.collisionGrid as string[] | string;
  const at = (x: number, y: number) =>
    Array.isArray(grid) ? (grid[y] as string)[x] : (grid as any)[y * width + x];

  // Overlap between footprints (excluding mainstreet, which is the road itself)
  const occ = new Map<string, string>();
  for (const loc of w.locations) {
    if (loc.type === 'mainstreet' || loc.type === 'alley') continue;
    const tx = loc.position.x / 32, ty = loc.position.y / 32;
    const tw = loc.position.width / 32, th = loc.position.height / 32;
    for (let y = ty; y < ty + th; y++)
      for (let x = tx; x < tx + tw; x++) {
        const k = `${x},${y}`;
        if (occ.has(k)) overlaps++;
        else occ.set(k, loc.type);
      }
  }

  // Entry points must be walkable
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && at(x, y) === '0';
  const starts: Array<[number, number, string]> = [];
  for (const loc of w.locations) {
    const ex = Math.floor(loc.entry_point.x / 32);
    const ey = Math.floor(loc.entry_point.y / 32);
    if (!walkable(ex, ey)) {
      blockedEntries++;
      blockedByType.set(loc.type, (blockedByType.get(loc.type) ?? 0) + 1);
    } else {
      starts.push([ex, ey, loc.type]);
    }
  }

  // BFS from the first walkable entry; every other entry must be reachable
  if (starts.length > 0) {
    const seen = new Uint8Array(width * height);
    const q: number[] = [starts[0][1] * width + starts[0][0]];
    seen[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const cur = q[i];
      const cx = cur % width, cy = (cur - cx) / width;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!walkable(nx, ny)) continue;
        const ni = ny * width + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    for (const [ex, ey] of starts) if (!seen[ey * width + ex]) unreachable++;
  }
}

console.log(`\n=== ENTRY POINTS ===`);
console.log(`blocked entry tiles: ${blockedEntries}`);
for (const [t, n] of blockedByType) console.log(`    ${t}: ${n}`);
console.log(`unreachable entries: ${unreachable}`);
console.log(`footprint overlaps:  ${overlaps}`);
