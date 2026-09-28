import { generateWorld } from '../../server/lib/worldgen';
import { buildSocialEdges } from '../../server/lib/worldgen/social';
import { AGENT_SEEDS } from '../../server/data/agents';

const agents = AGENT_SEEDS.map((a) => ({ name: a.name, homeName: a.homeName, workplaceName: a.workplaceName }));
const rels = AGENT_SEEDS.flatMap((a) => a.initialRelationships.map((r) => ({
  agentAName: a.name, agentBName: r.otherName, friendshipAB: r.friendshipAB, friendshipBA: r.friendshipBA,
  romanceAB: r.romanceAB, romanceBA: r.romanceBA, status: r.status, tags: r.tags,
})));
const idx = (n: string) => agents.findIndex((a) => a.name === n);
const scenario = {
  romanceThreads: [{ template_id: 'secret_fling', romance_values: [
    { from: idx('Marco Rivera'), to: idx('Lucia Fernandez'), value: 30 },
    { from: idx('Lucia Fernandez'), to: idx('Marco Rivera'), value: 25 }] }],
  rivalPairs: [] as [number, number][],
};
const edges = buildSocialEdges(rels, scenario, agents);
console.log(edges);
const door = (w: any, name: string) => { const h = w.locations.find((l: any) => l.name === name); return { x: Math.floor(h.entry_point.x / 32), y: Math.floor(h.entry_point.y / 32) }; };
const md = (a: any, b: any) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const N = Number(process.argv[2] ?? 60);
for (const social of [false, true]) {
  let rivBelow = 0, secAbove = 0; const rr: number[] = [], ss: number[] = [], mm: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const w = generateWorld({ seed: `probe-${i}`, sizeTier: 'auto', overrides: {} }, agents.length, social ? { agents, social: { edges } } : { agents });
    const homes = w.locations.filter((l) => l.type === 'home');
    const ds: number[] = [];
    for (let a = 0; a < homes.length; a++) for (let b = a + 1; b < homes.length; b++) ds.push(md(door(w, homes[a].name), door(w, homes[b].name)));
    const m = median(ds);
    const r = md(door(w, 'Home 6'), door(w, 'Home 9'));
    const s = md(door(w, 'Home 2'), door(w, 'Home 7'));
    rr.push(r); ss.push(s); mm.push(m);
    if (r < m) rivBelow++; if (s > m) secAbove++;
  }
  console.error(`social=${social} rival<median ${rivBelow}/${N} secret>median ${secAbove}/${N} rivalMed=${median(rr)} secretMed=${median(ss)} pairMed=${median(mm)} ms=${Date.now() - t0}`);
}
