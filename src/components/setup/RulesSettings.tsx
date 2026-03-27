import type { RulesConfig } from './types';

interface Props {
  config: RulesConfig;
  onChange: (config: RulesConfig) => void;
}

export function RulesSettings({ config, onChange }: Props) {
  void config;
  void onChange;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Rules & Simulation</h2>
      <p className="text-sm text-gray-400">Rules settings coming in next task...</p>
    </div>
  );
}
