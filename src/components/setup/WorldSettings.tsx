import type { WorldConfig } from './types';

interface Props {
  config: WorldConfig;
  onChange: (config: WorldConfig) => void;
}

const SEASONS: Array<{ value: WorldConfig['season']; icon: string; label: string }> = [
  { value: 'spring', icon: '🌸', label: 'Spring' },
  { value: 'summer', icon: '☀️', label: 'Summer' },
  { value: 'autumn', icon: '🍂', label: 'Autumn' },
  { value: 'winter', icon: '❄️', label: 'Winter' },
];

const WEATHER_OPTIONS = ['sunny', 'cloudy', 'rainy', 'stormy', 'foggy'];

export function WorldSettings({ config, onChange }: Props) {
  const update = (updates: Partial<WorldConfig>) => onChange({ ...config, ...updates });

  return (
    <div>
      <h2 className="text-lg font-bold mb-6">🌍 World Settings</h2>

      <div className="space-y-6 max-w-md">
        {/* Season */}
        <div>
          <label className="text-xs text-ui-dim uppercase block mb-2">Starting Season</label>
          <div className="flex gap-2">
            {SEASONS.map(s => (
              <button key={s.value} onClick={() => update({ season: s.value })}
                className={`flex-1 py-3 rounded-lg text-center transition-colors ${
                  config.season === s.value
                    ? 'bg-ui-gold/10 border border-ui-gold text-ui-text'
                    : 'bg-ui-panel border border-ui-line text-ui-dim hover:border-ui-line-accent'
                }`}>
                <div className="text-xl">{s.icon}</div>
                <div className="text-[10px] mt-1">{s.label}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Weather */}
        <div>
          <label className="text-xs text-ui-dim uppercase block mb-2">Starting Weather</label>
          <select value={config.weather} onChange={e => update({ weather: e.target.value as WorldConfig['weather'] })}
            className="w-full bg-ui-deep border border-ui-line rounded-lg px-3 py-2 text-sm text-ui-text capitalize">
            {WEATHER_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        {/* Time */}
        <div>
          <label className="text-xs text-ui-dim uppercase block mb-2">Starting Time — {config.startHour}:00 {config.startHour >= 12 ? 'PM' : 'AM'}</label>
          <input type="range" min={0} max={23} value={config.startHour}
            onChange={e => update({ startHour: Number(e.target.value) })}
            className="w-full accent-ui-gold" />
          <div className="flex justify-between text-[9px] text-ui-muted">
            <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
          </div>
        </div>

        {/* Day */}
        <div>
          <label className="text-xs text-ui-dim uppercase block mb-2">Starting Day</label>
          <input type="number" min={1} max={28} value={config.startDay}
            onChange={e => update({ startDay: Number(e.target.value) })}
            className="w-32 bg-ui-deep border border-ui-line rounded-lg px-3 py-2 text-sm text-ui-text" />
          <span className="text-xs text-ui-muted ml-2">of {config.season} (28 days per season)</span>
        </div>
      </div>
    </div>
  );
}
