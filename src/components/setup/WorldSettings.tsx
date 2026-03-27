import type { WorldConfig } from './types';

interface Props {
  config: WorldConfig;
  onChange: (config: WorldConfig) => void;
}

export function WorldSettings({ config, onChange }: Props) {
  void config;
  void onChange;
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">World Settings</h2>
      <p className="text-sm text-gray-400">World settings coming in next task...</p>
    </div>
  );
}
