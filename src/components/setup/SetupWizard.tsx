import { useMemo, useState } from 'react';
import type { AgentConfig, RelationshipConfig, SliderConfig, WorldGenConfig } from './types';
import { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET, PRESETS } from './types';
import { WorldLayout } from './WorldLayout';
import { AgentEditor } from './AgentEditor';
import { RelationshipEditor } from './RelationshipEditor';
import { WorldSettings } from './WorldSettings';
import { RulesSettings } from './RulesSettings';
import { PresetSelector } from './PresetSelector';
import { DramaSliders } from './DramaSliders';
import { SimulationPreview } from './SimulationPreview';
import { getDefaultAgents, getDefaultRelationships } from './defaults';
import { trpc } from '../../lib/trpc';
import { STEPS, type StepId } from './wizardSteps';

/** Short, readable, and enough entropy that two towns never collide by accident. */
function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SetupWizardProps {
  onStart: () => void;
}

export function SetupWizard({ onStart }: SetupWizardProps) {
  const [step, setStep] = useState<StepId>('scenario');
  const [agents, setAgents] = useState<AgentConfig[]>(getDefaultAgents());
  const [relationships, setRelationships] = useState<RelationshipConfig[]>(getDefaultRelationships());
  const [world, setWorld] = useState(DEFAULT_WORLD);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [starting, setStarting] = useState(false);
  // Read out of PRESETS rather than repeated as a literal: the old default was
  // `{drama:7, romance:6, crime:5, trust:5}`, 0-10 values on a 0-100 control, so
  // the town opened at near-zero drama and matched no preset card.
  const [sliders, setSliders] = useState<SliderConfig>(() => DEFAULT_PRESET.values);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(DEFAULT_PRESET.id);
  // Regenerating rerolls the scenario without touching the sliders.
  const [scenarioSeed, setScenarioSeed] = useState(() => randomSeed());
  const [worldgen, setWorldgen] = useState<WorldGenConfig>(DEFAULT_WORLDGEN);
  // Stable identity for `WorldLayout`, which memoises its preview key on it; an
  // inline `{ ...sliders, seed }` is a new object every render.
  const scenario = useMemo(() => ({ ...sliders, seed: scenarioSeed }), [sliders, scenarioSeed]);
  // Lives here, not in `WorldLayout`: that step unmounts when the user moves
  // on, so its local error would be gone by the time Start is reachable.
  // `setup.initialize` runs the same worldgen schema as `previewWorld`, so a
  // config the preview rejected fails Start with the identical message.
  const [worldgenError, setWorldgenError] = useState<string | null>(null);
  const initMutation = trpc.setup.initialize.useMutation();

  const stepIndex = STEPS.findIndex(s => s.id === step);

  const handleStart = async () => {
    setStarting(true);
    try {
      await initMutation.mutateAsync({
        agents,
        relationships,
        world,
        rules,
        worldgen,
        scenario: { ...sliders, seed: scenarioSeed },
      });
      onStart();
    } catch (err) {
      // Logged and also shown in the footer via `initMutation.error`: this used
      // to be console-only, so a rejected Start just re-enabled the button.
      console.error('Failed to start simulation:', err);
      setStarting(false);
    }
  };

  const handlePresetSelect = (preset: string, presetSliders: SliderConfig) => {
    setSelectedPreset(preset);
    setSliders(presetSliders);
  };

  const presetLabel = PRESETS.find(p => p.id === selectedPreset)?.label ?? 'your custom mix';

  const goNext = () => {
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  };
  const goBack = () => {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  };

  return (
    <div className="h-screen w-screen bg-ui-deep text-ui-text flex flex-col">
      {/* Header */}
      <div className="px-8 py-4 border-b border-ui-line flex items-center justify-between">
        <h1 className="text-lg font-bold">Little Life — Setup</h1>
        <div className="text-xs text-ui-muted">Configure your town before starting</div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 bg-ui-panel border-r border-ui-line py-4 flex flex-col gap-1 shrink-0">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(s.id)}
              className={`mx-2 px-3 py-2.5 rounded-lg text-left text-sm transition-colors flex items-center gap-2 ${
                step === s.id
                  ? 'bg-ui-gold/10 text-ui-gold border border-ui-gold/30'
                  : 'text-ui-dim hover:text-ui-text hover:bg-ui-hover/50'
              }`}
            >
              <span className="w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center bg-ui-raised text-ui-text">{s.icon}</span>
              <span>{s.label}</span>
              {i < stepIndex && <span className="ml-auto text-green-400 text-xs">done</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 'scenario' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-ui-text">Choose Your Drama</h2>
              {/* The other steps only tune defaults Start already has, so a first-time
                  player can skip them: same handleStart as the last step's button. */}
              <div className="flex items-center gap-4 border border-ui-line-accent bg-ui-gold/5 px-4 py-3 rounded-lg">
                <button
                  onClick={handleStart}
                  disabled={starting || agents.length < 2 || !!worldgenError}
                  className="px-5 py-2 text-sm bg-ui-gold text-ui-deep font-semibold hover:brightness-110 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {starting ? 'Starting...' : 'Quick Start'}
                </button>
                <div className="text-xs text-ui-dim">
                  Start now with <span className="text-ui-text">{presetLabel}</span>, the default cast and a town
                  generated for you. Or press Next to tune the cast, layout and rules first.
                  {worldgenError && (
                    <span className="block mt-1 text-red-400">Fix the World Layout step first: {worldgenError}</span>
                  )}
                  {initMutation.error && !starting && (
                    <span className="block mt-1 text-red-400 break-words">
                      Could not start: {initMutation.error.message}
                    </span>
                  )}
                </div>
              </div>
              <PresetSelector selectedId={selectedPreset} onSelect={handlePresetSelect} />
              <div className="border-t border-ui-line pt-4">
                <DramaSliders values={sliders} onChange={(s) => { setSliders(s); setSelectedPreset(null); }} />
              </div>
            </div>
          )}
          {step === 'preview' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-ui-text">Drama Preview</h2>
              <SimulationPreview
                scenario={{ ...sliders, seed: scenarioSeed }}
                agents={agents}
                onRegenerate={() => setScenarioSeed(randomSeed())}
              />
            </div>
          )}
          {step === 'worldlayout' && (
            <WorldLayout
              config={worldgen}
              onChange={setWorldgen}
              agents={agents}
              relationships={relationships}
              scenario={scenario}
              onErrorChange={setWorldgenError}
            />
          )}
          {step === 'agents' && (
            <AgentEditor agents={agents} onChange={setAgents} />
          )}
          {step === 'relationships' && (
            <RelationshipEditor
              agents={agents}
              relationships={relationships}
              onChange={setRelationships}
            />
          )}
          {step === 'world' && (
            <WorldSettings config={world} onChange={setWorld} />
          )}
          {step === 'rules' && (
            <RulesSettings config={rules} onChange={setRules} />
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-8 py-3 border-t border-ui-line flex items-center justify-between">
        <button
          onClick={goBack}
          disabled={stepIndex === 0}
          className="px-4 py-2 text-sm text-ui-dim hover:text-ui-text disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Back
        </button>
        <div className="text-xs text-ui-muted">
          Step {stepIndex + 1} of {STEPS.length}
        </div>
        {stepIndex < STEPS.length - 1 ? (
          <button
            onClick={goNext}
            className="px-4 py-2 text-sm bg-ui-gold text-ui-deep font-semibold hover:brightness-110 rounded-lg transition-colors"
          >
            Next
          </button>
        ) : (
          <div className="flex items-center gap-3">
            {worldgenError && (
              <span className="text-xs text-red-400 max-w-xs text-right">
                Fix the World Layout step: {worldgenError}
              </span>
            )}
            {initMutation.error && !starting && (
              <span className="text-xs text-red-400 max-w-xs text-right break-words">
                Could not start: {initMutation.error.message}
              </span>
            )}
            <button
              onClick={handleStart}
              disabled={starting || agents.length < 2 || !!worldgenError}
              className="px-6 py-2 text-sm bg-green-600 hover:bg-green-500 rounded-lg transition-colors font-medium disabled:opacity-50"
            >
              {starting ? 'Starting...' : 'Start Simulation'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
