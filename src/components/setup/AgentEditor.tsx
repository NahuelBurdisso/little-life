import type { AgentConfig } from './types';

interface AgentEditorProps {
  agents: AgentConfig[];
  onChange: (agents: AgentConfig[]) => void;
}

export function AgentEditor({ agents, onChange }: AgentEditorProps) {
  void onChange;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Agents ({agents.length})</h2>
      <p className="text-sm text-gray-400">Agent editor coming in next task...</p>
      <div className="grid grid-cols-3 gap-3 mt-4">
        {agents.map(a => (
          <div key={a.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
            <div className="text-sm font-medium text-white">{a.name}</div>
            <div className="text-xs text-gray-400">{a.age}{a.gender === 'female' ? 'F' : 'M'} &middot; {a.jobTitle}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
