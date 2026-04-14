import type { SliderConfig, DramaPreset } from './types';
import { PRESETS } from './types';

// ── Radar chart ──────────────────────────────────────────────────────────────
// 4 axes at 0°, 90°, 180°, 270° (drama, romance, crime, trust)
// Each axis goes from center (0) to edge (1).

const SIZE = 64; // px — viewBox is 0 0 64 64
const CX = 32;
const CY = 32;
const R = 26; // max radius

// axis angles (degrees): drama=top, romance=right, crime=bottom, trust=left
const AXES: { key: keyof SliderConfig; angleDeg: number }[] = [
  { key: 'drama',   angleDeg: -90 },
  { key: 'romance', angleDeg:   0 },
  { key: 'crime',   angleDeg:  90 },
  { key: 'trust',   angleDeg: 180 },
];

function toXY(angleDeg: number, ratio: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + Math.cos(rad) * R * ratio, CY + Math.sin(rad) * R * ratio];
}

function radarPolygon(values: SliderConfig): string {
  return AXES.map(({ key, angleDeg }) => {
    const ratio = values[key] / 100;
    const [x, y] = toXY(angleDeg, ratio);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

interface RadarChartProps {
  values: SliderConfig;
  selected: boolean;
}

function RadarChart({ values, selected }: RadarChartProps) {
  const polygon = radarPolygon(values);

  // axis endpoint labels colours
  const axisColour = selected ? '#60a5fa' : '#6b7280'; // blue-400 or gray-500

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="block mx-auto"
    >
      {/* Background grid circles */}
      {[0.25, 0.5, 0.75, 1].map((r) => (
        <circle
          key={r}
          cx={CX}
          cy={CY}
          r={R * r}
          fill="none"
          stroke="#374151"
          strokeWidth="0.5"
        />
      ))}

      {/* Axis lines */}
      {AXES.map(({ key, angleDeg }) => {
        const [x, y] = toXY(angleDeg, 1);
        return (
          <line
            key={key}
            x1={CX}
            y1={CY}
            x2={x}
            y2={y}
            stroke={axisColour}
            strokeWidth="0.5"
            opacity="0.5"
          />
        );
      })}

      {/* Data polygon */}
      <polygon
        points={polygon}
        fill={selected ? 'rgba(59,130,246,0.25)' : 'rgba(99,102,241,0.2)'}
        stroke={selected ? '#3b82f6' : '#818cf8'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Axis dots */}
      {AXES.map(({ key, angleDeg }) => {
        const ratio = values[key] / 100;
        const [x, y] = toXY(angleDeg, ratio);
        return (
          <circle
            key={key}
            cx={x}
            cy={y}
            r="2"
            fill={selected ? '#3b82f6' : '#818cf8'}
          />
        );
      })}
    </svg>
  );
}

// ── Preset card ───────────────────────────────────────────────────────────────

interface PresetCardProps {
  preset: DramaPreset;
  selected: boolean;
  onSelect: (id: string) => void;
}

function PresetCard({ preset, selected, onSelect }: PresetCardProps) {
  return (
    <button
      onClick={() => onSelect(preset.id)}
      className={`
        rounded-xl border p-3 text-left transition-all
        ${selected
          ? 'border-blue-500 bg-blue-600/10 ring-1 ring-blue-500/50'
          : 'border-gray-700 bg-gray-800 hover:border-gray-500 hover:bg-gray-750'
        }
      `}
    >
      <RadarChart values={preset.values} selected={selected} />

      <div className="mt-2 text-center">
        <div className={`text-sm font-semibold ${selected ? 'text-blue-300' : 'text-white'}`}>
          {preset.label}
        </div>
        <div className="mt-0.5 text-[10px] text-gray-400 leading-tight">
          {preset.description}
        </div>
      </div>

      {/* Mini value pills */}
      <div className="mt-2 flex flex-wrap gap-1 justify-center">
        {(Object.entries(preset.values) as [keyof SliderConfig, number][]).map(([key, val]) => (
          <span
            key={key}
            className={`
              text-[9px] px-1.5 py-0.5 rounded-full
              ${key === 'drama'   ? 'bg-red-900/40 text-red-300'     : ''}
              ${key === 'romance' ? 'bg-pink-900/40 text-pink-300'   : ''}
              ${key === 'crime'   ? 'bg-amber-900/40 text-amber-300' : ''}
              ${key === 'trust'   ? 'bg-emerald-900/40 text-emerald-300' : ''}
            `}
          >
            {key[0].toUpperCase()}{key.slice(1, 2)}: {val}
          </span>
        ))}
      </div>
    </button>
  );
}

// ── PresetSelector ────────────────────────────────────────────────────────────

interface PresetSelectorProps {
  selectedId: string | null;
  onSelect: (id: string, values: SliderConfig) => void;
}

export function PresetSelector({ selectedId, onSelect }: PresetSelectorProps) {
  const handleSelect = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) onSelect(id, preset.values);
  };

  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">Choose a Preset</h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Pick a starting point — you can fine-tune the sliders below.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            selected={selectedId === preset.id}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  );
}
