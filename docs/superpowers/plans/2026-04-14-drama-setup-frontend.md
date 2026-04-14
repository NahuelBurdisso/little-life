# Drama Setup Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Scenario step (presets + sliders) and Preview step to the SetupWizard, letting users configure drama levels before launching the simulation.

**Architecture:** Two new wizard steps inserted before the existing agent/relationship editors. PresetSelector shows 5 preset cards with SVG radar charts. DramaSliders provides 4 configurable sliders. SimulationPreview shows the generated drama config with agent moods, secret count, and romance threads. All backed by the `generateDrama` tRPC query endpoint.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, tRPC (WebSocket), inline SVG for radar charts

**Spec:** `docs/superpowers/specs/2026-04-14-drama-setup-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/components/setup/PresetSelector.tsx` | **NEW** — 5 preset cards with SVG radar charts |
| `src/components/setup/DramaSliders.tsx` | **NEW** — 4 slider controls (drama, romance, crime, trust) |
| `src/components/setup/SimulationPreview.tsx` | **NEW** — Preview generated config: agent moods, secrets, romance |
| `src/components/setup/SetupWizard.tsx` | Add 'scenario' + 'preview' steps, integrate new components |
| `src/components/setup/types.ts` | Add SliderConfig type |

---

## Task 1: Types + PresetSelector

**Files:**
- Modify: `src/components/setup/types.ts`
- Create: `src/components/setup/PresetSelector.tsx`

- [ ] **Step 1: Add SliderConfig type to types.ts**

Add at the end of `src/components/setup/types.ts`:

```typescript
export interface SliderConfig {
  drama: number;
  romance: number;
  crime: number;
  trust: number;
}

export const PRESETS: Record<string, { sliders: SliderConfig; description: string }> = {
  classic: { sliders: { drama: 7, romance: 6, crime: 5, trust: 5 }, description: 'The canonical enriched seed data' },
  powder_keg: { sliders: { drama: 9, romance: 4, crime: 8, trust: 2 }, description: 'Low trust, high crime, secrets everywhere' },
  love_and_lies: { sliders: { drama: 6, romance: 9, crime: 3, trust: 6 }, description: 'Love triangles, romantic secrets, jealousy' },
  quiet_start: { sliders: { drama: 3, romance: 3, crime: 2, trust: 8 }, description: 'High trust, few secrets — drama emerges organically' },
  total_chaos: { sliders: { drama: 10, romance: 8, crime: 9, trust: 1 }, description: 'Maximum everything' },
};
```

- [ ] **Step 2: Create PresetSelector.tsx**

Create `src/components/setup/PresetSelector.tsx`:

```tsx
import { PRESETS, type SliderConfig } from './types';

interface PresetSelectorProps {
  selected: string | null;
  onSelect: (preset: string, sliders: SliderConfig) => void;
}

function RadarChart({ sliders }: { sliders: SliderConfig }) {
  const size = 60;
  const center = size / 2;
  const radius = size / 2 - 4;
  const axes = [sliders.drama, sliders.romance, sliders.crime, sliders.trust];
  const angles = axes.map((_, i) => (Math.PI * 2 * i) / 4 - Math.PI / 2);

  const points = axes
    .map((v, i) => {
      const r = (v / 10) * radius;
      const x = center + r * Math.cos(angles[i]);
      const y = center + r * Math.sin(angles[i]);
      return `${x},${y}`;
    })
    .join(' ');

  // Axis lines
  const axisLines = angles.map((a, i) => {
    const x2 = center + radius * Math.cos(a);
    const y2 = center + radius * Math.sin(a);
    return <line key={i} x1={center} y1={center} x2={x2} y2={y2} stroke="#4b5563" strokeWidth={0.5} />;
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {axisLines}
      <polygon points={points} fill="rgba(59, 130, 246, 0.3)" stroke="#3b82f6" strokeWidth={1.5} />
    </svg>
  );
}

const PRESET_LABELS: Record<string, string> = {
  classic: 'Classic',
  powder_keg: 'Powder Keg',
  love_and_lies: 'Love & Lies',
  quiet_start: 'Quiet Start',
  total_chaos: 'Total Chaos',
};

export function PresetSelector({ selected, onSelect }: PresetSelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {Object.entries(PRESETS).map(([key, { sliders, description }]) => (
        <button
          key={key}
          onClick={() => onSelect(key, sliders)}
          className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors ${
            selected === key
              ? 'border-blue-500 bg-blue-900/30'
              : 'border-gray-700 bg-gray-800 hover:border-gray-500'
          }`}
        >
          <RadarChart sliders={sliders} />
          <span className="text-sm font-medium text-white">{PRESET_LABELS[key]}</span>
          <span className="text-xs text-gray-400 text-center">{description}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/setup/types.ts src/components/setup/PresetSelector.tsx
git commit -m "feat(setup-ui): add preset selector with SVG radar charts"
```

---

## Task 2: DramaSliders

**Files:**
- Create: `src/components/setup/DramaSliders.tsx`

- [ ] **Step 1: Create DramaSliders.tsx**

Create `src/components/setup/DramaSliders.tsx`:

```tsx
import type { SliderConfig } from './types';

interface DramaSlidersProps {
  sliders: SliderConfig;
  onChange: (sliders: SliderConfig) => void;
}

const SLIDER_META: Array<{
  key: keyof SliderConfig;
  label: string;
  description: string;
  lowLabel: string;
  highLabel: string;
  color: string;
}> = [
  { key: 'drama', label: 'Drama Intensity', description: 'Secrets, relationship volatility, mood', lowLabel: 'Peaceful', highLabel: 'Explosive', color: 'red' },
  { key: 'romance', label: 'Romance Density', description: 'Love threads, triangles, crushes', lowLabel: 'Platonic', highLabel: 'Passionate', color: 'pink' },
  { key: 'crime', label: 'Crime Pressure', description: 'Economic desperation, wealth gaps', lowLabel: 'Comfortable', highLabel: 'Desperate', color: 'amber' },
  { key: 'trust', label: 'Trust Level', description: 'Baseline trust, factions, rivalries', lowLabel: 'Paranoid', highLabel: 'Naive', color: 'emerald' },
];

const COLOR_MAP: Record<string, { track: string; thumb: string; accent: string }> = {
  red: { track: 'accent-red-500', thumb: 'text-red-400', accent: 'bg-red-500' },
  pink: { track: 'accent-pink-500', thumb: 'text-pink-400', accent: 'bg-pink-500' },
  amber: { track: 'accent-amber-500', thumb: 'text-amber-400', accent: 'bg-amber-500' },
  emerald: { track: 'accent-emerald-500', thumb: 'text-emerald-400', accent: 'bg-emerald-500' },
};

export function DramaSliders({ sliders, onChange }: DramaSlidersProps) {
  const handleChange = (key: keyof SliderConfig, value: number) => {
    onChange({ ...sliders, [key]: value });
  };

  return (
    <div className="space-y-5">
      {SLIDER_META.map(({ key, label, description, lowLabel, highLabel, color }) => {
        const colors = COLOR_MAP[color];
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-white">{label}</span>
                <span className="ml-2 text-xs text-gray-500">{description}</span>
              </div>
              <span className={`text-sm font-bold ${colors.thumb}`}>{sliders[key]}</span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={sliders[key]}
              onChange={(e) => handleChange(key, parseInt(e.target.value))}
              className={`w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-700 ${colors.track}`}
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>{lowLabel}</span>
              <span>{highLabel}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/setup/DramaSliders.tsx
git commit -m "feat(setup-ui): add drama sliders with color-coded controls"
```

---

## Task 3: SimulationPreview

**Files:**
- Create: `src/components/setup/SimulationPreview.tsx`

- [ ] **Step 1: Create SimulationPreview.tsx**

Create `src/components/setup/SimulationPreview.tsx`. This component shows the output of the `generateDrama` endpoint:

```tsx
interface GeneratedSecret {
  content: string;
  sensitivity: number;
  known_by_indices: number[];
}

interface RomanceThread {
  template_id: string;
  agent_indices: number[];
}

interface GenerationResult {
  secrets: GeneratedSecret[];
  romanceThreads: RomanceThread[];
  economyAdjustments: Record<number, number>;
  moodAdjustments: Record<number, { mood: number; stress: number }>;
  trustDelta: number;
  rivalPairs: Array<[number, number]>;
}

interface SimulationPreviewProps {
  result: GenerationResult | null;
  agentNames: string[];
  isLoading: boolean;
  onRegenerate: () => void;
}

function MoodIcon({ mood }: { mood: number }) {
  if (mood >= 60) return <span className="text-green-400">&#9786;</span>;
  if (mood >= 40) return <span className="text-yellow-400">&#9785;</span>;
  return <span className="text-red-400">&#9785;</span>;
}

function SensitivityBadge({ level }: { level: number }) {
  const colors = ['bg-gray-600', 'bg-yellow-600', 'bg-orange-600', 'bg-red-600'];
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[level] ?? colors[0]}`} />
  );
}

export function SimulationPreview({ result, agentNames, isLoading, onRegenerate }: SimulationPreviewProps) {
  if (isLoading) {
    return <div className="text-center text-gray-400 py-8">Generating drama configuration...</div>;
  }

  if (!result) {
    return <div className="text-center text-gray-500 py-8">Adjust sliders and generate a preview</div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex gap-4 text-sm">
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <span className="text-gray-400">Secrets: </span>
          <span className="font-bold text-white">{result.secrets.length}</span>
        </div>
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <span className="text-gray-400">Romance: </span>
          <span className="font-bold text-pink-400">{result.romanceThreads.length}</span>
        </div>
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <span className="text-gray-400">Rivals: </span>
          <span className="font-bold text-red-400">{result.rivalPairs.length}</span>
        </div>
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <span className="text-gray-400">Trust: </span>
          <span className={`font-bold ${result.trustDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {result.trustDelta >= 0 ? '+' : ''}{result.trustDelta}
          </span>
        </div>
      </div>

      {/* Agent moods */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Agent Starting Moods</h3>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {agentNames.map((name, i) => {
            const mood = result.moodAdjustments[i];
            const money = result.economyAdjustments[i];
            return (
              <div key={i} className="flex items-center gap-2 rounded bg-gray-800 px-3 py-1.5 text-sm">
                <MoodIcon mood={mood?.mood ?? 50} />
                <span className="text-white truncate">{name}</span>
                <span className="ml-auto text-gray-500">${money ?? 50}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Secrets */}
      {result.secrets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Secrets ({result.secrets.length})</h3>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {result.secrets.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-gray-400">
                <SensitivityBadge level={s.sensitivity} />
                <span>{s.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Romance threads */}
      {result.romanceThreads.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Romance Threads</h3>
          <div className="space-y-1">
            {result.romanceThreads.map((t, i) => (
              <div key={i} className="text-xs text-pink-300">
                {t.agent_indices.map(idx => agentNames[idx] ?? `Agent ${idx}`).join(' & ')} — {t.template_id.replace(/_/g, ' ')}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rival pairs */}
      {result.rivalPairs.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Rival Pairs</h3>
          <div className="space-y-1">
            {result.rivalPairs.map(([a, b], i) => (
              <div key={i} className="text-xs text-red-300">
                {agentNames[a] ?? `Agent ${a}`} vs {agentNames[b] ?? `Agent ${b}`}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Regenerate */}
      <button
        onClick={onRegenerate}
        className="w-full rounded-lg border border-gray-600 bg-gray-800 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
      >
        Regenerate (same sliders, new drama)
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/setup/SimulationPreview.tsx
git commit -m "feat(setup-ui): add simulation preview with mood, secrets, romance display"
```

---

## Task 4: Integrate into SetupWizard

**Files:**
- Modify: `src/components/setup/SetupWizard.tsx`

- [ ] **Step 1: Read SetupWizard.tsx and modify**

Read `src/components/setup/SetupWizard.tsx` fully. Make these changes:

1. Add imports:
```tsx
import { PresetSelector } from './PresetSelector';
import { DramaSliders } from './DramaSliders';
import { SimulationPreview } from './SimulationPreview';
import { PRESETS, type SliderConfig } from './types';
import { getDefaultAgents } from './defaults';
```

2. Update STEPS array — add 'scenario' and 'preview' before existing steps:
```tsx
const STEPS = [
  { id: 'scenario', label: 'Scenario', icon: 'S' },
  { id: 'preview', label: 'Preview', icon: 'P' },
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'relationships', label: 'Relationships', icon: 'R' },
  { id: 'world', label: 'World', icon: 'W' },
  { id: 'rules', label: 'Rules', icon: 'S' },
] as const;
```

3. Add state for sliders, preset selection, and preview result:
```tsx
const [sliders, setSliders] = useState<SliderConfig>({ drama: 7, romance: 6, crime: 5, trust: 5 });
const [selectedPreset, setSelectedPreset] = useState<string | null>('classic');
const [previewResult, setPreviewResult] = useState<any>(null);
const [isGenerating, setIsGenerating] = useState(false);
const defaultAgentNames = getDefaultAgents().map(a => a.name);
```

4. Add tRPC query for drama generation. Use the existing trpc pattern:
```tsx
const generateDrama = trpc.setup.generateDrama.useQuery(sliders, {
  enabled: false, // manual trigger only
});
```

Actually, since we need manual trigger with refetch, use a mutation-like pattern or useQuery with enabled:false + refetch. Check the tRPC version's API. Alternatively, use a simple fetch call or the existing trpc utility:

```tsx
const handleGenerate = async () => {
  setIsGenerating(true);
  try {
    const result = await utils.setup.generateDrama.fetch(sliders);
    setPreviewResult(result);
  } catch (e) {
    console.error('Drama generation failed:', e);
  } finally {
    setIsGenerating(false);
  }
};
```

Where `utils` comes from `const utils = trpc.useUtils()` (already exists if used elsewhere, or add it).

5. Add preset selection handler:
```tsx
const handlePresetSelect = (preset: string, presetSliders: SliderConfig) => {
  setSelectedPreset(preset);
  setSliders(presetSliders);
};
```

6. Add step content rendering for 'scenario' and 'preview':
```tsx
{currentStep === 'scenario' && (
  <div className="space-y-6">
    <h2 className="text-lg font-semibold text-white">Choose Your Drama</h2>
    <PresetSelector selected={selectedPreset} onSelect={handlePresetSelect} />
    <div className="border-t border-gray-700 pt-4">
      <h3 className="text-sm font-medium text-gray-300 mb-3">Fine-tune</h3>
      <DramaSliders sliders={sliders} onChange={(s) => { setSliders(s); setSelectedPreset(null); }} />
    </div>
  </div>
)}
{currentStep === 'preview' && (
  <div className="space-y-4">
    <h2 className="text-lg font-semibold text-white">Preview</h2>
    <SimulationPreview
      result={previewResult}
      agentNames={defaultAgentNames}
      isLoading={isGenerating}
      onRegenerate={handleGenerate}
    />
  </div>
)}
```

7. Auto-generate preview when entering the preview step. Add useEffect:
```tsx
useEffect(() => {
  if (currentStep === 'preview' && !previewResult) {
    handleGenerate();
  }
}, [currentStep]);
```

8. On "Start Simulation" — if user used sliders (not classic), the generated secrets/romance/economy should be applied. For now, start with the default agent data. The full integration of procedurally generated data into the `initialize` call is a future enhancement (requires extending SetupConfigSchema).

- [ ] **Step 2: Verify the app builds**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Expected: No errors (or minor fixable ones)

- [ ] **Step 3: Commit**

```bash
git add src/components/setup/SetupWizard.tsx
git commit -m "feat(setup-ui): integrate scenario and preview steps into SetupWizard"
```

---

## Task 5: Final Verification

- [ ] **Step 1: Run all tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All pass

- [ ] **Step 2: Verify TypeScript**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Fix any errors.

- [ ] **Step 3: Commit fixes if needed**

```bash
git add src/
git commit -m "fix(setup-ui): address build issues from wizard integration"
```
