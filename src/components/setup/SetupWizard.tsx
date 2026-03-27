import { useState } from 'react';
import type { SetupConfig, AgentConfig, RelationshipConfig } from './types';
import { DEFAULT_WORLD, DEFAULT_RULES } from './types';
import { AgentEditor } from './AgentEditor';
import { RelationshipEditor } from './RelationshipEditor';
import { WorldSettings } from './WorldSettings';
import { RulesSettings } from './RulesSettings';
import { getDefaultAgents, getDefaultRelationships } from './defaults';

const STEPS = [
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'relationships', label: 'Relationships', icon: 'R' },
  { id: 'world', label: 'World', icon: 'W' },
  { id: 'rules', label: 'Rules', icon: 'S' },
] as const;

type StepId = typeof STEPS[number]['id'];

interface SetupWizardProps {
  onStart: () => void;
}

export function SetupWizard({ onStart }: SetupWizardProps) {
  const [step, setStep] = useState<StepId>('agents');
  const [agents, setAgents] = useState<AgentConfig[]>(getDefaultAgents());
  const [relationships, setRelationships] = useState<RelationshipConfig[]>(getDefaultRelationships());
  const [world, setWorld] = useState(DEFAULT_WORLD);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [starting, setStarting] = useState(false);

  const stepIndex = STEPS.findIndex(s => s.id === step);

  const handleStart = async () => {
    setStarting(true);
    try {
      const config: SetupConfig = { agents, relationships, world, rules };
      // TODO: trpc.setup.initialize.useMutation() — endpoint created in Task 5
      // For now, log the config and proceed
      console.log('[SetupWizard] Starting simulation with config:', config);
      onStart();
    } catch (err) {
      console.error('Failed to start simulation:', err);
      setStarting(false);
    }
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
          <button
            onClick={handleStart}
            disabled={starting || agents.length < 2}
            className="px-6 py-2 text-sm bg-green-600 hover:bg-green-500 rounded-lg transition-colors font-medium disabled:opacity-50"
          >
            {starting ? 'Starting...' : 'Start Simulation'}
          </button>
        )}
      </div>
    </div>
  );
}
