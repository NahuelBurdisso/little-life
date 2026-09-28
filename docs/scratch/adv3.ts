import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { dimensionsStage } from '../../server/lib/worldgen/stages/dimensions';
import { makeRng } from '../../server/lib/worldgen/rng';
import { MAX_AGENTS } from '../../server/lib/worldgen/config';

function tryGen(label: string, cfg: any, n: number, seeds = 40) {
  let ok = 0, fail = 0, msg = '';
  const dims = new Set<string>();
  for (let s = 0; s < seeds; s++) {
    try {
      const w = generateWorld({ overrides: {}, ...cfg, seed: `e-${label}-${s}` }, n, {});
      ok++; dims.add(`${w.dimensions.width}x${w.dimensions.height}`);
    } catch (e: any) { fail++; if (!msg) msg = e.message; }
  }
  console.log(`${label} n=${n}: ok=${ok} fail=${fail} dims=${[...dims].join('/')} ${msg ? '| ' + msg.slice(0, 120) : ''}`);
}

// tier presets at max agents
tryGen('auto', { sizeTier: 'auto' }, MAX_AGENTS);
tryGen('medium', { sizeTier: 'medium' }, MAX_AGENTS);
tryGen('large', { sizeTier: 'large' }, MAX_AGENTS);
tryGen('custom-min', { sizeTier: 'custom', customDimensions: { width: 56, height: 43 } }, MAX_AGENTS);
tryGen('custom-max', { sizeTier: 'custom', customDimensions: { width: 90, height: 70 } }, MAX_AGENTS);
tryGen('override-min', { sizeTier: 'auto', overrides: { dimensions: { width: 56, height: 43 } } }, MAX_AGENTS);

// tiny agent counts
for (const n of [0, 1, 2, 3, 4]) tryGen('auto', { sizeTier: 'auto' }, n, 15);
// beyond MAX_AGENTS (worldgen does not enforce it)
for (const n of [33, 40, 60]) tryGen('auto-overcap', { sizeTier: 'auto' }, n, 10);

// dimensions stage direct
const r = makeRng(0);
for (const n of [0, 1, 13, 14, 15, 20, 30, 32, 40, 100]) {
  const d = dimensionsStage.run({} as any, r, { sizeTier: 'auto', overrides: {} } as any, n, {}).dimensions;
  process.stdout.write(`n=${n}:${d.width}x${d.height}  `);
}
console.log();

// does the override channel survive an expansion?
try {
  const w = generateWorld({ sizeTier: 'auto', overrides: { dimensions: { width: 56, height: 43 } }, seed: 'ovr' } as any, 32, {});
  console.log('override dims respected:', w.dimensions);
} catch (e: any) { console.log('override threw:', e.message.slice(0, 140)); }
