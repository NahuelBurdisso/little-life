import { useState, useMemo } from 'react';
import type { AgentConfig, RelationshipConfig } from './types';

interface Props {
  agents: AgentConfig[];
  relationships: RelationshipConfig[];
  onChange: (rels: RelationshipConfig[]) => void;
}

type FilterMode = 'all' | 'set' | 'friends' | 'romantic' | 'rivals';

function deriveStatus(fAB: number, fBA: number, rAB: number, rBA: number): string {
  const avgF = (fAB + fBA) / 2;
  const maxR = Math.max(rAB, rBA);
  const minR = Math.min(rAB, rBA);
  if (minR > 70 && avgF > 30) return 'partners';
  if (maxR > 30) return 'romantic_interest';
  if (avgF > 90) return 'best_friends';
  if (avgF > 70) return 'close_friends';
  if (avgF > 40) return 'friends';
  if (avgF < -70) return 'enemies';
  if (avgF < -40) return 'rivals';
  if (avgF > 10) return 'acquaintances';
  return 'strangers';
}

function findRel(rels: RelationshipConfig[], nameA: string, nameB: string): RelationshipConfig | undefined {
  return rels.find(r =>
    (r.agentAName === nameA && r.agentBName === nameB) ||
    (r.agentAName === nameB && r.agentBName === nameA)
  );
}

function isNonDefault(rel: RelationshipConfig | undefined): boolean {
  if (!rel) return false;
  return rel.friendshipAB !== 5 || rel.friendshipBA !== 5 ||
    rel.romanceAB > 0 || rel.romanceBA > 0 ||
    rel.trustAB !== 5 || rel.trustBA !== 5 ||
    rel.tags.length > 0;
}

export function RelationshipEditor({ agents, relationships, onChange }: Props) {
  const [filter, setFilter] = useState<FilterMode>('all');
  const [search, setSearch] = useState('');

  // Generate all possible pairs with current relationship data
  const allPairs = useMemo(() => {
    const pairs: Array<{ a: string; b: string }> = [];
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        pairs.push({ a: agents[i].name, b: agents[j].name });
      }
    }
    return pairs;
  }, [agents]);

  const filtered = allPairs.filter(p => {
    if (search) {
      const q = search.toLowerCase();
      if (!p.a.toLowerCase().includes(q) && !p.b.toLowerCase().includes(q)) return false;
    }
    const rel = findRel(relationships, p.a, p.b);
    const avgF = rel ? (rel.friendshipAB + rel.friendshipBA) / 2 : 5;
    const maxR = rel ? Math.max(rel.romanceAB, rel.romanceBA) : 0;

    if (filter === 'set') return isNonDefault(rel);
    if (filter === 'friends') return avgF > 30;
    if (filter === 'romantic') return maxR > 15;
    if (filter === 'rivals') return avgF < -20;
    return true;
  });

  const updateRel = (nameA: string, nameB: string, updates: Partial<RelationshipConfig>) => {
    const existingIdx = relationships.findIndex(r =>
      (r.agentAName === nameA && r.agentBName === nameB) ||
      (r.agentAName === nameB && r.agentBName === nameA)
    );

    const base: RelationshipConfig = existingIdx >= 0
      ? relationships[existingIdx]
      : { agentAName: nameA, agentBName: nameB, friendshipAB: 5, friendshipBA: 5, romanceAB: 0, romanceBA: 0, trustAB: 5, trustBA: 5, familiarity: 10, status: 'acquaintances', tags: [] };

    const merged = { ...base, ...updates };
    merged.status = deriveStatus(merged.friendshipAB, merged.friendshipBA, merged.romanceAB, merged.romanceBA);

    if (existingIdx >= 0) {
      const newRels = [...relationships];
      newRels[existingIdx] = merged;
      onChange(newRels);
    } else {
      onChange([...relationships, merged]);
    }
  };

  const applyPreset = (nameA: string, nameB: string, preset: string) => {
    const presets: Record<string, Partial<RelationshipConfig>> = {
      friends: { friendshipAB: 50, friendshipBA: 50, romanceAB: 0, romanceBA: 0, trustAB: 40, trustBA: 40, familiarity: 60, tags: [] },
      close: { friendshipAB: 70, friendshipBA: 70, romanceAB: 0, romanceBA: 0, trustAB: 60, trustBA: 60, familiarity: 80, tags: [] },
      rivals: { friendshipAB: -40, friendshipBA: -40, romanceAB: 0, romanceBA: 0, trustAB: -20, trustBA: -20, familiarity: 50, tags: ['grudge'] },
      romantic: { friendshipAB: 55, friendshipBA: 55, romanceAB: 50, romanceBA: 50, trustAB: 45, trustBA: 45, familiarity: 70, tags: ['crush'] },
      strangers: { friendshipAB: 5, friendshipBA: 5, romanceAB: 0, romanceBA: 0, trustAB: 5, trustBA: 5, familiarity: 10, tags: [] },
    };
    if (presets[preset]) updateRel(nameA, nameB, presets[preset]);
  };

  const filterCounts = useMemo(() => {
    let set = 0, friends = 0, romantic = 0, rivals = 0;
    for (const p of allPairs) {
      const rel = findRel(relationships, p.a, p.b);
      if (isNonDefault(rel)) set++;
      const avgF = rel ? (rel.friendshipAB + rel.friendshipBA) / 2 : 5;
      const maxR = rel ? Math.max(rel.romanceAB, rel.romanceBA) : 0;
      if (avgF > 30) friends++;
      if (maxR > 15) romantic++;
      if (avgF < -20) rivals++;
    }
    return { all: allPairs.length, set, friends, romantic, rivals };
  }, [allPairs, relationships]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">🤝 Relationships</h2>
        <span className="text-xs text-ui-muted">{filtered.length} pairs shown</span>
      </div>

      <div className="flex gap-2 mb-3 flex-wrap">
        {(['all', 'set', 'friends', 'romantic', 'rivals'] as FilterMode[]).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-[10px] px-2 py-1 rounded-md ${filter === f ? 'bg-ui-hover text-ui-text' : 'text-ui-dim hover:text-ui-text'}`}>
            {f} ({filterCounts[f]})
          </button>
        ))}
        <input placeholder="Search agent..." value={search} onChange={e => setSearch(e.target.value)}
          className="ml-auto bg-ui-deep border border-ui-line rounded px-2 py-1 text-xs text-ui-text w-40" />
      </div>

      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {filtered.map(p => {
          const rel = findRel(relationships, p.a, p.b);
          const fAB = rel?.friendshipAB ?? 5;
          const rAB = rel?.romanceAB ?? 0;
          const tAB = rel?.trustAB ?? 5;
          const status = rel?.status ?? 'strangers';

          return (
            <div key={`${p.a}-${p.b}`} className="bg-ui-panel border border-ui-line rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-ui-text font-medium">{p.a} ↔ {p.b}</div>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-ui-raised text-ui-text capitalize">
                  {status.replace(/_/g, ' ')}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-2">
                <div>
                  <label className="text-[9px] text-ui-muted block mb-0.5">Friendship ({fAB})</label>
                  <input type="range" min={-100} max={100} value={fAB}
                    onChange={e => updateRel(p.a, p.b, { friendshipAB: Number(e.target.value), friendshipBA: Number(e.target.value) })}
                    className="w-full h-1 accent-green-500" />
                </div>
                <div>
                  <label className="text-[9px] text-ui-muted block mb-0.5">Romance ({rAB})</label>
                  <input type="range" min={0} max={100} value={rAB}
                    onChange={e => updateRel(p.a, p.b, { romanceAB: Number(e.target.value), romanceBA: Number(e.target.value) })}
                    className="w-full h-1 accent-pink-500" />
                </div>
                <div>
                  <label className="text-[9px] text-ui-muted block mb-0.5">Trust ({tAB})</label>
                  <input type="range" min={-100} max={100} value={tAB}
                    onChange={e => updateRel(p.a, p.b, { trustAB: Number(e.target.value), trustBA: Number(e.target.value) })}
                    className="w-full h-1 accent-ui-gold" />
                </div>
              </div>

              <div className="flex gap-1">
                {['friends', 'close', 'rivals', 'romantic', 'strangers'].map(preset => (
                  <button key={preset} onClick={() => applyPreset(p.a, p.b, preset)}
                    className="text-[9px] px-1.5 py-0.5 bg-ui-raised hover:bg-ui-hover rounded text-ui-text capitalize">
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-xs text-ui-muted italic py-4 text-center">
            No pairs match your filter. Try "all" to see everyone.
          </p>
        )}
      </div>
    </div>
  );
}
