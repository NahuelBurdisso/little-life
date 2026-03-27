import type { AgentConfig, RelationshipConfig } from './types';

interface Props {
  agents: AgentConfig[];
  relationships: RelationshipConfig[];
  onChange: (rels: RelationshipConfig[]) => void;
}

export function RelationshipEditor({ agents, relationships, onChange }: Props) {
  void agents;
  void onChange;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Relationships ({relationships.length} set)</h2>
      <p className="text-sm text-gray-400">Relationship editor coming in next task...</p>
    </div>
  );
}
