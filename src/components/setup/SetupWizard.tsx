import { useState } from 'react';
import type { AgentConfig, RelationshipConfig, SliderConfig, WorldGenConfig } from './types';
import { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET } from './types';
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

const STEPS = [
  { id: 'scenario', label: 'Scenario', icon: 'S' },
  { id: 'preview', label: 'Preview', icon: 'P' },
  { id: 'worldlayout', label: 'World Layout', icon: 'L' },
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'relationships', label: 'Relationships', icon: 'R' },
  { id: 'world', label: 'World', icon: 'W' },
  { id: 'rules', label: 'Rules', icon: 'S' },
] as const;

type StepId = typeof STEPS[number]['id'];

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
      console.error('Failed to start simulation:', err);
      setStarting(false);
    }
  };

  const handlePresetSelect = (preset: string, presetSliders: SliderConfig) => {
    setSelectedPreset(preset);
    setSliders(presetSliders);
  };

  const goNext = () => {
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  };
  const goBack = () => {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  };

  return (
    <div className="h-screen w-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <div className="px-8 py-4 border-b border-gray-700 flex items-center justify-between">
        <h1 className="text-lg font-bold">Little Life — Setup</h1>
        <div className="text-xs text-gray-500">Configure your town before starting</div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 bg-gray-800 border-r border-gray-700 py-4 flex flex-col gap-1 shrink-0">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(s.id)}
              className={`mx-2 px-3 py-2.5 rounded-lg text-left text-sm transition-colors flex items-center gap-2 ${
                step === s.id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
              }`}
            >
              <span className="w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center bg-gray-700 text-gray-300">{s.icon}</span>
              <span>{s.label}</span>
              {i < stepIndex && <span className="ml-auto text-green-400 text-xs">done</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 'scenario' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-white">Choose Your Drama</h2>
              <PresetSelector selectedId={selectedPreset} onSelect={handlePresetSelect} />
              <div className="border-t border-gray-700 pt-4">
                <DramaSliders values={sliders} onChange={(s) => { setSliders(s); setSelectedPreset(null); }} />
              </div>
            </div>
          )}
          {step === 'preview' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Drama Preview</h2>
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
              scenario={{ ...sliders, seed: scenarioSeed }}
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
      <div className="px-8 py-3 border-t border-gray-700 flex items-center justify-between">
        <button
          onClick={goBack}
          disabled={stepIndex === 0}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Back
        </button>
        <div className="text-xs text-gray-600">
          Step {stepIndex + 1} of {STEPS.length}
        </div>
        {stepIndex < STEPS.length - 1 ? (
          <button
            onClick={goNext}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
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
