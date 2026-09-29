import type { SliderConfig } from './types';

// ── Slider metadata ───────────────────────────────────────────────────────────

interface SliderMeta {
  key: keyof SliderConfig;
  label: string;
  description: string;
  lowLabel: string;
  highLabel: string;
  colour: {
    accent: string;       // Tailwind accent-* (used in inline style)
    track: string;        // bg-* for the filled track
    value: string;        // text-* for the current value
    badge: string;        // bg+text for the value badge
  };
}

const SLIDERS: SliderMeta[] = [
  {
    key: 'drama',
    label: 'Drama',
    description: 'How often dramatic events — arguments, betrayals, public scenes — erupt in the town.',
    lowLabel: 'Peaceful',
    highLabel: 'Explosive',
    colour: {
      accent: '#ef4444',
      track: 'bg-red-500',
      value: 'text-red-400',
      badge: 'bg-red-900/40 text-red-300 border-red-700/50',
    },
  },
  {
    key: 'romance',
    label: 'Romance',
    description: 'Probability that agents develop crushes, pursue relationships, or spark jealousy.',
    lowLabel: 'Platonic',
    highLabel: 'Steamy',
    colour: {
      accent: '#ec4899',
      track: 'bg-pink-500',
      value: 'text-pink-400',
      badge: 'bg-pink-900/40 text-pink-300 border-pink-700/50',
    },
  },
  {
    key: 'crime',
    label: 'Crime',
    description: 'Rate of criminal acts: theft, vandalism, deception, and darker secrets.',
    lowLabel: 'Safe',
    highLabel: 'Dangerous',
    colour: {
      accent: '#f59e0b',
      track: 'bg-amber-500',
      value: 'text-amber-400',
      badge: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
    },
  },
  {
    key: 'trust',
    label: 'Trust',
    description: 'Baseline inter-agent trust. Low trust breeds rumours; high trust enables cooperation.',
    lowLabel: 'Suspicious',
    highLabel: 'Open',
    colour: {
      accent: '#10b981',
      track: 'bg-ui-good',
      value: 'text-ui-good',
      badge: 'bg-ui-good/15 text-ui-good border-ui-good/40',
    },
  },
];

// ── Single slider row ─────────────────────────────────────────────────────────

interface SingleSliderProps {
  meta: SliderMeta;
  value: number;
  onChange: (value: number) => void;
}

function SingleSlider({ meta, value, onChange }: SingleSliderProps) {
  const fillPct = value; // 0–100

  return (
    <div className="bg-ui-panel rounded-sm p-4 border border-ui-line">
      {/* Header row */}
      <div className="flex items-start justify-between mb-1.5">
        <div>
          <span className="text-sm font-semibold text-ui-text">{meta.label}</span>
          <p className="text-[11px] text-ui-dim mt-0.5 leading-tight max-w-xs">
            {meta.description}
          </p>
        </div>
        {/* Current value badge */}
        <span
          className={`
            ml-4 shrink-0 text-sm font-bold px-2.5 py-0.5 rounded-lg border
            ${meta.colour.badge}
          `}
        >
          {value}
        </span>
      </div>

      {/* Slider */}
      <div className="relative mt-3">
        {/*
          We render a custom track behind the native range so we can colour the
          filled portion without browser-specific pseudo-element hacks.
        */}
        <div className="relative h-2 rounded-full bg-ui-raised overflow-hidden">
          <div
            className={`absolute left-0 top-0 h-full ${meta.colour.track} transition-all duration-75`}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
          style={{ accentColor: meta.colour.accent }}
        />
      </div>

      {/* Low / high labels */}
      <div className="flex justify-between mt-1.5">
        <span className="text-[10px] text-ui-muted">{meta.lowLabel}</span>
        <span className="text-[10px] text-ui-muted">{meta.highLabel}</span>
      </div>
    </div>
  );
}

// ── DramaSliders ──────────────────────────────────────────────────────────────

interface DramaSlidersProps {
  values: SliderConfig;
  onChange: (values: SliderConfig) => void;
}

export function DramaSliders({ values, onChange }: DramaSlidersProps) {
  const update = (key: keyof SliderConfig, value: number) =>
    onChange({ ...values, [key]: value });

  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ui-text">Fine-Tune Sliders</h3>
        <p className="text-[11px] text-ui-muted mt-0.5">
          Adjust each axis to match the tone you want for this simulation run.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {SLIDERS.map((meta) => (
          <SingleSlider
            key={meta.key}
            meta={meta}
            value={values[meta.key]}
            onChange={(v) => update(meta.key, v)}
          />
        ))}
      </div>
    </div>
  );
}
