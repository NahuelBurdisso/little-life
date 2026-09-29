import { useState, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { trpc } from '../../lib/trpc';
import { WorldPreview } from './WorldPreview';
import {
  type WorldGenConfig,
  type AgentConfig,
  type RelationshipConfig,
  type ScenarioConfig,
  WORLDGEN_MIN_WIDTH,
  WORLDGEN_MAX_WIDTH,
  WORLDGEN_MIN_HEIGHT,
  WORLDGEN_MAX_HEIGHT,
  TIER_DIMENSIONS,
} from './types';

interface WorldLayoutProps {
  config: WorldGenConfig;
  /** Accepts an updater so `onSuccess` can write `seed` without clobbering a
   *  `sizeTier`/`customDimensions` edit made while the preview was in flight. */
  onChange: Dispatch<SetStateAction<WorldGenConfig>>;
  agents: AgentConfig[];
  /** With `agents`, the relationship graph worldgen places households by —
   *  sent so the preview is the town Start will build, not a socially random
   *  one that silently reshuffles on Start. */
  relationships: RelationshipConfig[];
  scenario: ScenarioConfig;
  /** Reports the current worldgen error (or `null`) to the wizard so it can
   *  gate "Start Simulation". This step is unmounted on other steps, so the
   *  state has to live in the parent to survive to the last step. */
  onErrorChange?: (error: string | null) => void;
}

/** Round and pin to the schema bounds. Non-numeric input falls back to `min`. */
function clampDimension(raw: string, min: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function randomSeed(len = 8): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function WorldLayout({
  config, onChange, agents, relationships, scenario, onErrorChange,
}: WorldLayoutProps) {
  const previewMutation = trpc.setup.previewWorld.useMutation();
  const [previewResult, setPreviewResult] = useState<any>(null);
  const [seedDraft, setSeedDraft] = useState<string>(config.seed ?? '');
  // Local rather than `previewMutation.error`, which is shared hook state: a
  // superseded request that rejects after the newest one resolved painted a red
  // error banner over a perfectly valid preview.
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Monotonic id for the in-flight preview. `useMutation` has no cancellation,
  // so two rapid tier/size edits can resolve out of order and paint the older
  // world; only the newest request is allowed to write state.
  const requestId = useRef(0);

  // The seed+deps signature of a request whose resolved seed this component
  // wrote back into `config.seed` itself. `config.seed` is an effect dep, so
  // that writeback re-triggered the effect and made every first preview fire an
  // identical second request. Keyed on the non-seed deps too, so a later
  // genuine change (tier, size, agents) is never mistaken for the echo.
  const seedEcho = useRef<string | null>(null);

  const agentCount = agents.length;

  // Auto-preview on mount + whenever scalar config changes. Deps are scalars
  // (customW, customH, homeNamesKey) NOT objects — object identity changes
  // on every render and would cause a mutation-fire loop.
  const customW = config.customDimensions?.width ?? 0;
  const customH = config.customDimensions?.height ?? 0;
  const homeNamesKey = agents.map((a) => a.homeName).join('|');
  // Everything social placement reads: names, homes and workplaces, the
  // relationship rows, and the scenario (whose romance threads and rivalries
  // depend on the agents' ages and personalities too, so the whole agent list
  // goes in). A string, so it is a stable scalar dep; memoised so the
  // serialisation runs only when one of its inputs changes, not every render.
  const socialOff = config.socialPlacement === false;
  const socialKey = useMemo(
    () => (socialOff ? 'off' : JSON.stringify([agents, relationships, scenario])),
    [socialOff, agents, relationships, scenario],
  );
  const layoutStyle = config.layoutStyle ?? 'grid';
  const depKey =
    `${config.sizeTier}|${layoutStyle}|${customW}|${customH}|${agentCount}|${homeNamesKey}|${socialKey}`;

  // Client-side bounds check on the Custom size. `min`/`max` on
  // `<input type="number">` only constrain the spinner — typed and pasted text
  // goes straight through, and clearing the field yields `Number('') === 0`,
  // which is not nullish so the `?? WORLDGEN_MIN_*` display fallback never
  // fires. Without this an out-of-range size was sent to `previewWorld` and
  // then, unblocked, to `initialize`, and only the server Zod bound caught it.
  //
  // Short-circuiting to `null` off the custom tier is only sound because the
  // tier `onChange` below now clears `customDimensions` when leaving Custom.
  // The server validates that object whenever it is PRESENT, not only when the
  // tier is custom, so if either half of that pair is changed the other must
  // change with it — otherwise an out-of-range size rides a non-custom tier
  // straight past this check.
  const dimensionError =
    config.sizeTier !== 'custom'
      ? null
      : customW < WORLDGEN_MIN_WIDTH || customW > WORLDGEN_MAX_WIDTH
        ? `Width must be between ${WORLDGEN_MIN_WIDTH} and ${WORLDGEN_MAX_WIDTH}.`
        : customH < WORLDGEN_MIN_HEIGHT || customH > WORLDGEN_MAX_HEIGHT
          ? `Height must be between ${WORLDGEN_MIN_HEIGHT} and ${WORLDGEN_MAX_HEIGHT}.`
          : null;

  const error = dimensionError ?? previewError;

  // Report upward. Done in an effect, not inline in the handlers, so every path
  // that changes validity (typing, tier change, a superseded request) reports
  // exactly once and never sets parent state during this component's render.
  useEffect(() => {
    onErrorChange?.(error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useEffect(() => {
    if (agentCount === 0) {
      setPreviewResult(null);
      return;
    }
    // Don't spend a round trip on a config the server is guaranteed to reject;
    // bump the id so an in-flight response can't paint over the local error.
    if (dimensionError) {
      requestId.current++;
      return;
    }
    // Skip the re-run caused by our own seed writeback in `onSuccess` below.
    if (seedEcho.current === `${config.seed}|${depKey}`) return;
    const id = ++requestId.current;
    setPreviewError(null);
    previewMutation.mutate(
      {
        ...config,
        agentCount,
        // The full cast rather than `previewAgentHomes`: social placement needs
        // names and workplaces, and the scenario needs the rest.
        agents,
        relationships,
        scenario,
      },
      {
        onError: (err) => {
          if (id !== requestId.current) return; // superseded by a newer request
          setPreviewError(err.message);
        },
        onSuccess: (result) => {
          if (id !== requestId.current) return; // superseded by a newer request
          setPreviewResult(result);
          setPreviewError(null);
          // Commit the generated seed to config, not just the draft input.
          // `onChange` previously fired only from Regenerate and the seed field's
          // onBlur, so previewing and immediately clicking Next submitted an
          // empty seed — and the persisted world was not the one shown.
          //
          // Written through an updater rather than `{ ...config, seed }`: that
          // spread captured `config` as it was when the effect ran, so a late
          // response overwrote a `sizeTier` or `customDimensions` edit made in
          // the meantime.
          if (result.seed) {
            setSeedDraft((draft) => draft || result.seed);
            seedEcho.current = `${result.seed}|${depKey}`;
            onChange((prev) => (prev.seed ? prev : { ...prev, seed: result.seed }));
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.seed, config.sizeTier, layoutStyle, customW, customH, agentCount, homeNamesKey, socialKey]);

  // Always a fresh seed. It used to be `seedDraft.trim() || randomSeed()`, but
  // the preview writes the resolved seed back into both `config.seed` and
  // `seedDraft`, so from the second preview onward the draft was never empty:
  // Regenerate re-committed the seed already in use, no effect dep changed, and
  // the button did nothing — while the warnings block below told the user to
  // press it for a different town. Typing a seed and blurring the field is the
  // separate "use this exact seed" action.
  const handleRegenerate = () => {
    const seed = randomSeed();
    setSeedDraft(seed);
    onChange((prev) => ({ ...prev, seed }));
  };

  const handleSeedCommit = () => {
    const seed = seedDraft.trim() || undefined;
    onChange((prev) => ({ ...prev, seed }));
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
              onChange={(e) => {
                const sizeTier = e.target.value as WorldGenConfig['sizeTier'];
                onChange((prev) => ({
                  ...prev,
                  sizeTier,
                  // Seed the dimensions the moment Custom is picked. The inputs
                  // below display `customDimensions?.width ?? MIN`, so without
                  // this the user saw a valid 56 × 43 while `customDimensions`
                  // was still `undefined` — and the auto-preview that fires on
                  // this very change was rejected by the server's
                  // "sizeTier='custom' requires customDimensions" refine, as
                  // was Start. Seeding here makes the shown value and the
                  // submitted value the same object.
                  //
                  // And DROP it on the way out of Custom. This used to preserve
                  // `prev.customDimensions` for the other tiers, but the server
                  // bound is unconditional — worldgen/config.ts validates
                  // `customDimensions` whenever the key is present, regardless
                  // of `sizeTier`. So typing 9 into Width and switching Size
                  // back to Auto left `{ width: 9, ... }` riding along in the
                  // config: `dimensionError` reported clean (it only checks the
                  // custom tier), and both previewWorld and initialize were
                  // rejected with "customDimensions.width: Number must be
                  // greater than or equal to 56" on a screen whose Width field
                  // is unmounted, leaving no way to fix it without guessing.
                  // The cost is that a custom size is not remembered across a
                  // tier round-trip, which is cheaper than an unfixable error.
                  customDimensions:
                    sizeTier === 'custom'
                      ? prev.customDimensions ?? {
                          width: WORLDGEN_MIN_WIDTH,
                          height: WORLDGEN_MIN_HEIGHT,
                        }
                      : undefined,
                }));
              }}
            >
              <option value="auto">Auto (scales with agents)</option>
              {/* Labels come from the same table the server sizes the tier from,
                  so they cannot drift apart. */}
              <option value="medium">
                Medium ({TIER_DIMENSIONS.medium.width} × {TIER_DIMENSIONS.medium.height})
              </option>
              <option value="large">
                Large ({TIER_DIMENSIONS.large.width} × {TIER_DIMENSIONS.large.height})
              </option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {/* Town style. Same seed, same buildings — only the street network
              (and so where everything lands) changes. */}
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Town style</label>
            <select
              className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
              value={layoutStyle}
              onChange={(e) => {
                const next = e.target.value as NonNullable<WorldGenConfig['layoutStyle']>;
                onChange((prev) => ({ ...prev, layoutStyle: next }));
              }}
            >
              <option value="grid">Grid (planned streets)</option>
              <option value="organic">Organic village (winding lanes)</option>
            </select>
          </div>

          {/* Social placement toggle. Plot selection is identical either way;
              this only decides which household gets which house. */}
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={config.socialPlacement !== false}
              onChange={(e) => {
                const socialPlacement = e.target.checked;
                onChange((prev) => ({ ...prev, socialPlacement }));
              }}
            />
            Place homes by relationships
            <span className="text-xs text-gray-500">(rivals next door, secret lovers across town)</span>
          </label>

          {/* The tier labels promise a number, and the pipeline quietly grows the
              map when content does not fit — at 32 agents "Medium" returned 72×54
              in 13% of seeds with no client-side signal at all. Show what was
              actually generated, and say so when it differs. */}
          {previewResult && (
            <div className="text-xs text-gray-500">
              Generated: {previewResult.dimensions.width} × {previewResult.dimensions.height} tiles
              {(() => {
                const preset = TIER_DIMENSIONS[config.sizeTier as keyof typeof TIER_DIMENSIONS];
                if (!preset) return null;
                if (preset.width === previewResult.dimensions.width &&
                    preset.height === previewResult.dimensions.height) return null;
                return (
                  <span className="text-amber-400">
                    {' '}— grown from {preset.width} × {preset.height} to fit {agentCount} agents
                  </span>
                );
              })()}
            </div>
          )}

          {/* Optional plots the generator could not fit. These are cosmetic — no
              services, no interior — so this is a nudge to reroll, not an error.
              It used to be a console.warn on server stdout, and the preview drew
              the gap as a 2px dashed outline at 40% alpha, which nobody could
              see. Measured over 480 worlds at 13/20/30 agents: 12.9% ship
              missing at least one plot. */}
          {previewResult?.warnings?.length > 0 && (
            <div className="text-xs text-amber-400 space-y-0.5">
              {previewResult.warnings.map((w: string) => (
                <div key={w}>{w} Regenerate for a different town.</div>
              ))}
            </div>
          )}

          {config.sizeTier === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Width</label>
                {/* `value={customW || ''}` so backspacing the field empty leaves
                    it empty instead of snapping back to a literal 0.
                    Out-of-range values are allowed while typing — clamping on
                    every keystroke makes "70" unreachable, since the "7" would
                    pin to 56 first. `dimensionError` blocks the preview in the
                    meantime and onBlur pins the value before it can be
                    submitted. */}
                <input
                  type="number"
                  min={WORLDGEN_MIN_WIDTH} max={WORLDGEN_MAX_WIDTH}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={customW || ''}
                  onChange={(e) => {
                    const typed = Math.round(Number(e.target.value));
                    const width = Number.isFinite(typed) ? typed : 0;
                    onChange((prev) => ({
                      ...prev,
                      customDimensions: {
                        width,
                        height: prev.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT,
                      },
                    }));
                  }}
                  onBlur={(e) => {
                    const width = clampDimension(e.target.value, WORLDGEN_MIN_WIDTH, WORLDGEN_MAX_WIDTH);
                    onChange((prev) => ({
                      ...prev,
                      customDimensions: {
                        width,
                        height: prev.customDimensions?.height ?? WORLDGEN_MIN_HEIGHT,
                      },
                    }));
                  }}
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Height</label>
                <input
                  type="number"
                  min={WORLDGEN_MIN_HEIGHT} max={WORLDGEN_MAX_HEIGHT}
                  className="mt-1 w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  value={customH || ''}
                  onChange={(e) => {
                    const typed = Math.round(Number(e.target.value));
                    const height = Number.isFinite(typed) ? typed : 0;
                    onChange((prev) => ({
                      ...prev,
                      customDimensions: {
                        width: prev.customDimensions?.width ?? WORLDGEN_MIN_WIDTH,
                        height,
                      },
                    }));
                  }}
                  onBlur={(e) => {
                    const height = clampDimension(e.target.value, WORLDGEN_MIN_HEIGHT, WORLDGEN_MAX_HEIGHT);
                    onChange((prev) => ({
                      ...prev,
                      customDimensions: {
                        width: prev.customDimensions?.width ?? WORLDGEN_MIN_WIDTH,
                        height,
                      },
                    }));
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={agentCount === 0 || previewMutation.isPending || !!dimensionError}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm disabled:opacity-30"
            >
              Regenerate
            </button>
            {previewMutation.isPending && (
              <span className="text-xs text-gray-500 self-center">Generating…</span>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}
        </div>

        <WorldPreview result={previewResult} />
      </div>
    </div>
  );
}
