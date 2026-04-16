import { useState, useEffect } from 'react';
import { trpc } from '../../lib/trpc';
import { WorldPreview } from './WorldPreview';
import {
  type WorldGenConfig,
  type AgentConfig,
  WORLDGEN_MIN_WIDTH,
  WORLDGEN_MAX_WIDTH,
  WORLDGEN_MIN_HEIGHT,
  WORLDGEN_MAX_HEIGHT,
} from './types';

interface WorldLayoutProps {
  config: WorldGenConfig;
  onChange: (cfg: WorldGenConfig) => void;
  agents: AgentConfig[];
}

function randomSeed(len = 8): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function WorldLayout({ config, onChange, agents }: WorldLayoutProps) {
  const previewMutation = trpc.setup.previewWorld.useMutation();
  const [previewResult, setPreviewResult] = useState<any>(null);
  const [seedDraft, setSeedDraft] = useState<string>(config.seed ?? '');

  const agentCount = agents.length;
  const previewAgentHomes = agents.map((a) => ({ homeName: a.homeName }));

  // Auto-preview on mount + whenever scalar config changes. Deps are scalars
  // (customW, customH, homeNamesKey) NOT objects — object identity changes
  // on every render and would cause a mutation-fire loop.
  const customW = config.customDimensions?.width ?? 0;
  const customH = config.customDimensions?.height ?? 0;
  const homeNamesKey = agents.map((a) => a.homeName).join('|');

  useEffect(() => {
    if (agentCount === 0) {
      setPreviewResult(null);
      return;
    }
    previewMutation.mutate(
      {
        ...config,
        agentCount,
        previewAgentHomes,
      },
      {
        onSuccess: (result) => {
          setPreviewResult(result);
          if (!config.seed && result.seed) setSeedDraft(result.seed);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.seed, config.sizeTier, customW, customH, agentCount, homeNamesKey]);

  const handleRegenerate = () => {
    const seed = seedDraft.trim() || randomSeed();
    setSeedDraft(seed);
    onChange({ ...config, seed });
  };

  const handleSeedCommit = () => {
    onChange({ ...config, seed: seedDraft.trim() || undefined });
  };

  const handleCopySeed = async () => {
    if (!seedDraft) return;
    await navigator.clipboard.writeText(seedDraft);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">World Layout</h2>

      <div className="flex gap-8">
        <div className="flex-1 space-y-4">
          {/* Seed input */}
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Seed</label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm font-mono"
                placeholder="blank = random per regenerate"
                value={seedDraft}
                onChange={(e) => setSeedDraft(e.target.value)}
                onBlur={handleSeedCommit}
              />
              <button
                onClick={handleCopySeed}
                disabled={!seedDraft}
                className="px-2 py-1 text-xs text-gray-400 hover:text-white disabled:opacity-30"
                title="Copy seed to clipboard"
              >
                copy
              </button>
            </div>
          </div>

          {/* Size tier */}
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Size</label>
            <select
              className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
              value={config.sizeTier}
              onChange={(e) => onChange({ ...config, sizeTier: e.target.value as WorldGenConfig['sizeTier'] })}
            >
              <option value="auto">Auto (scales with agents)</option>
              <option value="medium">Medium (60 × 45)</option>
              <option value="large">Large (80 × 60)</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {config.sizeTier === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Width</label>
                <input
                  type="number"
                  min={WORLDGEN_MIN_WIDTH} max={WORLDGEN_MAX_WIDTH}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={config.customDimensions?.width ?? WORLDGEN_MIN_WIDTH}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      customDimensions: {
                        width: Number(e.target.value),
                        height: config.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Height</label>
                <input
                  type="number"
                  min={WORLDGEN_MIN_HEIGHT} max={WORLDGEN_MAX_HEIGHT}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={config.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      customDimensions: {
                        width: config.customDimensions?.width ?? WORLDGEN_MIN_WIDTH,
                        height: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={agentCount === 0 || previewMutation.isPending}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm disabled:opacity-30"
            >
              Regenerate
            </button>
            {previewMutation.isPending && (
              <span className="text-xs text-gray-500 self-center">Generating…</span>
            )}
          </div>

          {previewMutation.error && (
            <div className="text-xs text-red-400">{previewMutation.error.message}</div>
          )}
        </div>

        <WorldPreview result={previewResult} />
      </div>
    </div>
  );
}
