import { useState } from 'react';
import type { AgentConfig, PersonalityConfig } from './types';
import { JOB_OPTIONS, HOME_OPTIONS } from './types';

interface AgentEditorProps {
  agents: AgentConfig[];
  onChange: (agents: AgentConfig[]) => void;
}

const PERSONALITY_AXES: { key: keyof PersonalityConfig; low: string; high: string }[] = [
  { key: 'honesty', low: 'Deceptive', high: 'Blunt' },
  { key: 'aggression', low: 'Peaceful', high: 'Aggressive' },
  { key: 'warmth', low: 'Cold', high: 'Warm' },
  { key: 'impulsiveness', low: 'Disciplined', high: 'Impulsive' },
  { key: 'vanity', low: 'Humble', high: 'Vain' },
  { key: 'curiosity', low: 'Incurious', high: 'Nosy' },
  { key: 'loyalty', low: 'Disloyal', high: 'Loyal' },
  { key: 'morality', low: 'Amoral', high: 'Principled' },
  { key: 'sensuality', low: 'Reserved', high: 'Sensual' },
  { key: 'neuroticism', low: 'Stable', high: 'Neurotic' },
];

function randomPersonality(): PersonalityConfig {
  const rand = () => 20 + Math.floor(Math.random() * 60);
  return {
    honesty: rand(), aggression: rand(), warmth: rand(), impulsiveness: rand(),
    vanity: rand(), curiosity: rand(), loyalty: rand(), morality: rand(),
    sensuality: rand(), neuroticism: rand(),
  };
}

function personalitySummary(p: PersonalityConfig): string {
  const high = PERSONALITY_AXES.filter(a => p[a.key] > 65).map(a => a.high.toLowerCase());
  const low = PERSONALITY_AXES.filter(a => p[a.key] < 35).map(a => a.low.toLowerCase());
  const traits = [...high.slice(0, 2), ...low.slice(0, 1)];
  return traits.length > 0 ? traits.join(', ') : 'balanced';
}

export function AgentEditor({ agents, onChange }: AgentEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const editingAgent = agents.find(a => a.id === editingId) ?? null;

  const updateAgent = (id: string, updates: Partial<AgentConfig>) => {
    onChange(agents.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const addAgent = () => {
    const id = String(Date.now());
    const newAgent: AgentConfig = {
      id, name: 'New Resident', age: 25 + Math.floor(Math.random() * 30),
      gender: Math.random() > 0.5 ? 'male' : 'female', bio: '', traits: [],
      job: 'retired', jobTitle: 'Retired', salary: 15,
      homeName: HOME_OPTIONS.find(h => (homeUsage.get(h) ?? 0) < 2) ?? HOME_OPTIONS[0], workplaceName: null,
      schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: ['park', 'tavern'] },
      personality: randomPersonality(), backstoryMemories: [],
    };
    onChange([...agents, newAgent]);
    setEditingId(id);
  };

  const removeAgent = (id: string) => {
    if (agents.length <= 2) return;
    onChange(agents.filter(a => a.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const setJob = (id: string, jobKey: string) => {
    const opt = JOB_OPTIONS.find(j => j.job === jobKey);
    if (!opt) return;
    updateAgent(id, { job: opt.job, jobTitle: opt.title, salary: opt.salary, workplaceName: opt.workplace });
  };

  // Homes have capacity 2 each, 9 homes = 18 max agents
  const MAX_AGENTS = HOME_OPTIONS.length * 2;
  const homeUsage = new Map<string, number>();
  agents.forEach(a => homeUsage.set(a.homeName, (homeUsage.get(a.homeName) ?? 0) + 1));
  const overCapacity = Array.from(homeUsage.entries()).filter(([, count]) => count > 2);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">👥 Agents ({agents.length}/{MAX_AGENTS})</h2>
        <button onClick={addAgent} disabled={agents.length >= MAX_AGENTS}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
          + New Resident
        </button>
      </div>

      {overCapacity.length > 0 && (
        <div className="mb-3 p-2 bg-yellow-900/20 border border-yellow-700/30 rounded-lg text-[10px] text-yellow-300">
          ⚠️ Over-capacity homes: {overCapacity.map(([h, c]) => `${h} (${c}/2)`).join(', ')}. Reassign agents or remove extras.
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-4">
        {agents.map(a => (
          <div key={a.id} className={`bg-gray-800 border rounded-lg p-3 cursor-pointer transition-colors hover:border-blue-500 ${editingId === a.id ? 'border-blue-500' : 'border-gray-700'}`} onClick={() => setEditingId(a.id)}>
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-medium text-white truncate">{a.name}</div>
              <button onClick={(e) => { e.stopPropagation(); removeAgent(a.id); }} className="text-gray-600 hover:text-red-400 text-xs">✕</button>
            </div>
            <div className="text-[10px] text-gray-400">{a.age}{a.gender === 'female' ? 'F' : 'M'} • {a.jobTitle}</div>
            <div className="text-[9px] text-gray-500 mt-1 truncate italic">{personalitySummary(a.personality)}</div>
          </div>
        ))}
      </div>

      {editingAgent && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-white">Editing: {editingAgent.name}</h3>
            <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-white text-sm">✕</button>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <label className="text-[10px] text-gray-400 uppercase block mb-1">Name</label>
              <input value={editingAgent.name} onChange={e => updateAgent(editingAgent.id, { name: e.target.value })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase block mb-1">Age</label>
              <input type="number" value={editingAgent.age} onChange={e => updateAgent(editingAgent.id, { age: Number(e.target.value) })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase block mb-1">Gender</label>
              <select value={editingAgent.gender} onChange={e => updateAgent(editingAgent.id, { gender: e.target.value })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white">
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
          </div>

          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase block mb-1">Job</label>
            <select value={editingAgent.job} onChange={e => setJob(editingAgent.id, e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white">
              {JOB_OPTIONS.map(j => <option key={j.job} value={j.job}>{j.title} (${j.salary}/day{j.workplace ? ` at ${j.workplace}` : ''})</option>)}
            </select>
          </div>

          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase block mb-1">Bio</label>
            <textarea value={editingAgent.bio} onChange={e => updateAgent(editingAgent.id, { bio: e.target.value })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white h-16 resize-none" placeholder="Write a short backstory..." />
          </div>

          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase block mb-2">Personality</label>
            <div className="space-y-2">
              {PERSONALITY_AXES.map(axis => (
                <div key={axis.key} className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-16 text-right">{axis.low}</span>
                  <input type="range" min={0} max={100} value={editingAgent.personality[axis.key]}
                    onChange={e => updateAgent(editingAgent.id, { personality: { ...editingAgent.personality, [axis.key]: Number(e.target.value) } })}
                    className="flex-1 h-1.5 accent-blue-500" />
                  <span className="text-[9px] text-gray-500 w-16">{axis.high}</span>
                  <span className="text-[10px] text-gray-400 w-6 text-right">{editingAgent.personality[axis.key]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase block mb-1">Traits</label>
            <div className="flex flex-wrap gap-1 mb-1">
              {editingAgent.traits.map((t, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded flex items-center gap-1">
                  {t}
                  <button onClick={() => updateAgent(editingAgent.id, { traits: editingAgent.traits.filter((_, j) => j !== i) })} className="text-gray-500 hover:text-red-400">×</button>
                </span>
              ))}
            </div>
            <input placeholder="Type trait + Enter" className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white w-48"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                  updateAgent(editingAgent.id, { traits: [...editingAgent.traits, (e.target as HTMLInputElement).value.trim()] });
                  (e.target as HTMLInputElement).value = '';
                }
              }} />
          </div>

          <button onClick={() => setShowAdvanced(!showAdvanced)} className="text-[10px] text-gray-500 hover:text-gray-300 mb-3">
            {showAdvanced ? '▼ Hide advanced' : '▶ Show advanced (home, schedule)'}
          </button>

          {showAdvanced && (
            <div className="border-t border-gray-700 pt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase block mb-1">Home</label>
                  <select value={editingAgent.homeName} onChange={e => updateAgent(editingAgent.id, { homeName: e.target.value })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white">
                    {HOME_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase block mb-1">Salary</label>
                  <input type="number" value={editingAgent.salary} onChange={e => updateAgent(editingAgent.id, { salary: Number(e.target.value) })} className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white" />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(['wakeTime', 'workStart', 'workEnd', 'sleepTime'] as const).map(field => (
                  <div key={field}>
                    <label className="text-[9px] text-gray-500 block mb-0.5 capitalize">{field.replace('Time', '').replace(/([A-Z])/g, ' $1')}</label>
                    <input type="number" min={0} max={23} value={editingAgent.schedule[field]}
                      onChange={e => updateAgent(editingAgent.id, { schedule: { ...editingAgent.schedule, [field]: Number(e.target.value) } })}
                      className="w-full bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[10px] text-white" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
