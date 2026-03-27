import type { RulesConfig } from './types';

interface Props {
  config: RulesConfig;
  onChange: (config: RulesConfig) => void;
}

type RateOption = 'off' | 'low' | 'medium' | 'high';
type DramaOption = 'low' | 'medium' | 'high' | 'chaos';

function RateSelector({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="text-xs text-gray-400 uppercase block mb-2">{label}</label>
      <div className="flex gap-1">
        {options.map(o => (
          <button key={o} onClick={() => onChange(o)}
            className={`flex-1 py-1.5 text-xs rounded-md capitalize transition-colors ${
              value === o
                ? 'bg-blue-600/20 border border-blue-500 text-white'
                : 'bg-gray-800 border border-gray-700 text-gray-400 hover:border-gray-500'
            }`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RulesSettings({ config, onChange }: Props) {
  const update = (updates: Partial<RulesConfig>) => onChange({ ...config, ...updates });

  return (
    <div>
      <h2 className="text-lg font-bold mb-6">⚙️ Rules & Simulation</h2>

      <div className="grid grid-cols-2 gap-8 max-w-2xl">
        {/* Left column: Simulation rules */}
        <div className="space-y-5">
          <h3 className="text-xs text-gray-500 uppercase font-medium">Simulation</h3>

          {/* Death toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white">Death Enabled</div>
              <div className="text-[10px] text-gray-500">Agents can die from neglect, sickness, or old age</div>
            </div>
            <button onClick={() => update({ deathEnabled: !config.deathEnabled })}
              className={`w-10 h-5 rounded-full transition-colors ${config.deathEnabled ? 'bg-blue-500' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${config.deathEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <RateSelector label="Sickness Rate" value={config.sicknessRate}
            onChange={v => update({ sicknessRate: v as RateOption })} options={['off', 'low', 'medium', 'high']} />

          <RateSelector label="Contagion Rate" value={config.contagionRate}
            onChange={v => update({ contagionRate: v as RateOption })} options={['off', 'low', 'medium', 'high']} />

          <RateSelector label="Drama Intensity" value={config.dramaIntensity}
            onChange={v => update({ dramaIntensity: v as DramaOption })} options={['low', 'medium', 'high', 'chaos']} />

          {/* Starting money */}
          <div>
            <label className="text-xs text-gray-400 uppercase block mb-2">Starting Money — ${config.startingMoney}</label>
            <input type="range" min={10} max={500} step={10} value={config.startingMoney}
              onChange={e => update({ startingMoney: Number(e.target.value) })}
              className="w-full accent-yellow-500" />
            <div className="flex justify-between text-[9px] text-gray-600"><span>$10</span><span>$250</span><span>$500</span></div>
          </div>

          {/* Tick speed */}
          <div>
            <label className="text-xs text-gray-400 uppercase block mb-2">Tick Speed — {config.tickSpeed}x</label>
            <input type="range" min={0.5} max={4} step={0.5} value={config.tickSpeed}
              onChange={e => update({ tickSpeed: Number(e.target.value) })}
              className="w-full accent-blue-500" />
            <div className="flex justify-between text-[9px] text-gray-600"><span>0.5x</span><span>1x</span><span>2x</span><span>4x</span></div>
          </div>
        </div>

        {/* Right column: LLM settings */}
        <div className="space-y-5">
          <h3 className="text-xs text-gray-500 uppercase font-medium">LLM / AI</h3>

          <div>
            <label className="text-xs text-gray-400 uppercase block mb-1">Model</label>
            <input value={config.llmModel} onChange={e => update({ llmModel: e.target.value })}
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              placeholder="e.g. dolphin3:8b" />
            <div className="text-[9px] text-gray-600 mt-1">Any Ollama model name</div>
          </div>

          <div>
            <label className="text-xs text-gray-400 uppercase block mb-2">Temperature — {config.llmTemperature}</label>
            <input type="range" min={0.1} max={2.0} step={0.1} value={config.llmTemperature}
              onChange={e => update({ llmTemperature: Number(e.target.value) })}
              className="w-full accent-orange-500" />
            <div className="flex justify-between text-[9px] text-gray-600"><span>0.1 (focused)</span><span>1.0</span><span>2.0 (creative)</span></div>
          </div>

          <div>
            <label className="text-xs text-gray-400 uppercase block mb-2">Max Tokens — {config.llmMaxTokens}</label>
            <input type="range" min={100} max={500} step={50} value={config.llmMaxTokens}
              onChange={e => update({ llmMaxTokens: Number(e.target.value) })}
              className="w-full accent-purple-500" />
            <div className="flex justify-between text-[9px] text-gray-600"><span>100 (short)</span><span>250</span><span>500 (long)</span></div>
          </div>

          <div className="mt-6 p-3 bg-gray-800/50 border border-gray-700 rounded-lg">
            <div className="text-[10px] text-gray-500 uppercase font-medium mb-1">Drama Intensity Effects</div>
            <div className="text-[10px] text-gray-400 space-y-0.5">
              {config.dramaIntensity === 'low' && <p>Fewer dark dynamics triggers. Peaceful town life.</p>}
              {config.dramaIntensity === 'medium' && <p>Balanced drama. Default experience.</p>}
              {config.dramaIntensity === 'high' && <p>More theft, jealousy, conflict. Lower thresholds for dark behaviors.</p>}
              {config.dramaIntensity === 'chaos' && <p>Everything fires more often. Shorter immunity. Maximum drama. 🔥</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
