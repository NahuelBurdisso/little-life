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

function getOrCreateRel(rels: RelationshipConfig[], nameA: string, nameB: string): RelationshipConfig {
  const existing = rels.find(r =>
    (r.agentAName === nameA && r.agentBName === nameB) ||
    (r.agentAName === nameB && r.agentBName === nameA)
  );
  if (existing) return existing;
  return {
    agentAName: nameA, agentBName: nameB,
    friendshipAB: 5, friendshipBA: 5, romanceAB: 0, romanceBA: 0,
    trustAB: 5, trustBA: 5, familiarity: 10, status: 'acquaintances', tags: [],
  };
}

export function RelationshipEditor({ agents, relationships, onChange }: Props) {
  const [filter, setFilter] = useState<FilterMode>('set');
  const [search, setSearch] = useState('');

  // Generate all possible pairs
  const allPairs = useMemo(() => {
    const pairs: Array<{ a: string; b: string; rel: RelationshipConfig }> = [];
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const rel = getOrCreateRel(relationships, agents[i].name, agents[j].name);
        pairs.push({ a: agents[i].name, b: agents[j].name, rel });
      }
    }
    return pairs;
  }, [agents, relationships]);

  const filtered = allPairs.filter(p => {
    if (search) {
      const q = search.toLowerCase();
      if (!p.a.toLowerCase().includes(q) && !p.b.toLowerCase().includes(q)) return false;
    }
    const avgF = (p.rel.friendshipAB + p.rel.friendshipBA) / 2;
    const maxR = Math.max(p.rel.romanceAB, p.rel.romanceBA);
    if (filter === 'set') return avgF !== 5 || maxR > 0; // non-default
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
    const base = getOrCreateRel(relationships, nameA, nameB);
    const updated = { ...base, ...updates, status: deriveStatus(
      updates.friendshipAB ?? base.friendshipAB, updates.friendshipBA ?? base.friendshipBA,
      updates.romanceAB ?? base.romanceAB, updates.romanceBA ?? base.romanceBA,
    )};
    if (existingIdx >= 0) {
      const newRels = [...relationships];
      newRels[existingIdx] = updated;
      onChange(newRels);
    } else {
      onChange([...relationships, updated]);
    }
  };

  const applyPreset = (nameA: string, nameB: string, preset: string) => {
    switch (preset) {
      case 'friends': updateRel(nameA, nameB, { friendshipAB: 50, friendshipBA: 50, trustAB: 40, trustBA: 40, familiarity: 60 }); break;
      case 'close': updateRel(nameA, nameB, { friendshipAB: 70, friendshipBA: 70, trustAB: 60, trustBA: 60, familiarity: 80 }); break;
      case 'rivals': updateRel(nameA, nameB, { friendshipAB: -40, friendshipBA: -40, trustAB: -20, trustBA: -20, familiarity: 50, tags: ['grudge'] }); break;
      case 'romantic': updateRel(nameA, nameB, { friendshipAB: 55, friendshipBA: 55, romanceAB: 50, romanceBA: 50, trustAB: 45, trustBA: 45, familiarity: 70, tags: ['crush'] }); break;
      case 'strangers': updateRel(nameA, nameB, { friendshipAB: 5, friendshipBA: 5, romanceAB: 0, romanceBA: 0, trustAB: 5, trustBA: 5, familiarity: 10, tags: [] }); break;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">🤝 Relationships</h2>
        <span className="text-xs text-gray-500">{filtered.length} / {allPairs.length} pairs</span>
      </div>

      <div className="flex gap-2 mb-3">
        {(['all', 'set', 'friends', 'romantic', 'rivals'] as FilterMode[]).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-[10px] px-2 py-1 rounded-md ${filter === f ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'}`}>
            {f}
          </button>
        ))}
        <input placeholder="Search agent..." value={search} onChange={e => setSearch(e.target.value)}
          className="ml-auto bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white w-40" />
      </div>

      <div className="space-y-2 max-h-[50vh] overflow-y-auto">
        {filtered.map(p => (
          <div key={`${p.a}-${p.b}`} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-white font-medium">{p.a} ↔ {p.b}</div>
              <div className="flex gap-1">
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 capitalize">{p.rel.status.replace(/_/g, ' ')}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-2">
              <div>
                <label className="text-[9px] text-gray-500 block mb-0.5">Friendship</label>
                <input type="range" min={-100} max={100} value={p.rel.friendshipAB}
                  onChange={e => updateRel(p.a, p.b, { friendshipAB: Number(e.target.value), friendshipBA: Number(e.target.value) })}
                  className="w-full h-1 accent-green-500" />
                <div className="text-[9px] text-gray-500 text-center">{p.rel.friendshipAB}</div>
              </div>
              <div>
                <label className="text-[9px] text-gray-500 block mb-0.5">Romance</label>
                <input type="range" min={0} max={100} value={p.rel.romanceAB}
                  onChange={e => updateRel(p.a, p.b, { romanceAB: Number(e.target.value), romanceBA: Number(e.target.value) })}
                  className="w-full h-1 accent-pink-500" />
                <div className="text-[9px] text-gray-500 text-center">{p.rel.romanceAB}</div>
              </div>
              <div>
                <label className="text-[9px] text-gray-500 block mb-0.5">Trust</label>
                <input type="range" min={-100} max={100} value={p.rel.trustAB}
                  onChange={e => updateRel(p.a, p.b, { trustAB: Number(e.target.value), trustBA: Number(e.target.value) })}
                  className="w-full h-1 accent-blue-500" />
                <div className="text-[9px] text-gray-500 text-center">{p.rel.trustAB}</div>
              </div>
            </div>

            <div className="flex gap-1">
              {['friends', 'close', 'rivals', 'romantic', 'strangers'].map(p2 => (
                <button key={p2} onClick={() => applyPreset(p.a, p.b, p2)}
                  className="text-[9px] px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 capitalize">{p2}</button>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-xs text-gray-500 italic py-4 text-center">No pairs match your filter.</p>}
      </div>
    </div>
  );
}
