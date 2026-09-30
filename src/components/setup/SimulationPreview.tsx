import type { AgentConfig, ScenarioConfig } from './types';
import { trpc } from '../../lib/trpc';

/**
 * Preview of the scenario the drama sliders produce.
 *
 * This used to fabricate its own drama client-side from a private template list
 * — the numbers and the secrets shown here had no connection to the world that
 * Start then built, which seeded no slider-derived content at all. It now
 * renders exactly what `setup.initialize` will persist: same generator, same
 * agents, same seed.
 */

// ── Display helpers ───────────────────────────────────────────────────────────

const SENSITIVITY_META: Record<number, { label: string; colour: string }> = {
  1: { label: 'Low', colour: 'bg-ui-raised/50 text-ui-dim' },
  2: { label: 'Medium', colour: 'bg-orange-900/40 text-orange-300' },
  3: { label: 'Explosive', colour: 'bg-red-900/50 text-red-300 font-bold' },
};

/** The generator emits mood/stress numbers; these are the bands the sim reads. */
function moodMeta(mood: number, stress: number): { emoji: string; label: string; colour: string } {
  if (stress >= 40) return { emoji: '😰', label: 'stressed', colour: 'bg-purple-900/30 text-purple-300 border-purple-700/40' };
  if (mood < 45) return { emoji: '😔', label: 'low', colour: 'bg-ui-raised/40 text-ui-dim border-ui-line/40' };
  if (mood >= 70) return { emoji: '😊', label: 'happy', colour: 'bg-yellow-500/20 text-yellow-300 border-yellow-700/40' };
  return { emoji: '😌', label: 'content', colour: 'bg-green-900/30 text-green-300 border-green-700/40' };
}

const firstName = (full: string) => full.split(' ')[0];

// ── Component ─────────────────────────────────────────────────────────────────

interface SimulationPreviewProps {
  scenario: ScenarioConfig;
  agents: AgentConfig[];
  onRegenerate: () => void;
}

export function SimulationPreview({ scenario, agents, onRegenerate }: SimulationPreviewProps) {
  const { data, isLoading, error } = trpc.setup.generateDrama.useQuery(
    { scenario, agents },
    // Agents can be edited after this step, and the seed changes on Regenerate;
    // both are already in the query key, so nothing else should refetch it.
    { enabled: agents.length >= 2, staleTime: Infinity },
  );

  const nameOf = (index: number) => agents[index]?.name ?? `Agent ${index}`;

  const moods = data
    ? agents.map((a, i) => ({ name: a.name, ...(data.moodAdjustments[i] ?? { mood: 60, stress: 15 }) }))
    : [];

  // Romance threads carry their own optional secret, and those are seeded too,
  // as are the opening hooks' facts (server/lib/dramaHooks.ts).
  const secrets = data
    ? [...data.secrets, ...data.romanceThreads.flatMap((t) => (t.secret ? [t.secret] : [])), ...data.hooks.secrets]
    : [];
  // The hooks' trade feud is a rival pair like the trust slider's.
  const rivals = data ? [...data.rivalPairs, ...(data.hooks.rivalry ? [data.hooks.rivalry.pair] : [])] : [];

  const money = data ? Object.values(data.economyAdjustments) : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-ui-text">Simulation Preview</h3>
          <p className="text-[11px] text-ui-muted mt-0.5">
            Exactly what your town starts with. Seed {scenario.seed}.
          </p>
        </div>
        <button
          onClick={onRegenerate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-ui-raised hover:bg-ui-hover rounded-lg text-ui-text hover:text-ui-text transition-colors border border-ui-line"
        >
          <span>↺</span>
          Regenerate
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400 mb-3">Could not build the scenario: {error.message}</p>
      )}
      {isLoading && <p className="text-xs text-ui-muted">Generating…</p>}

      {data && (
        <>
          <div className="grid grid-cols-4 gap-2 mb-4">
            <Stat label="Secrets" value={secrets.length} colour="text-amber-400" />
            <Stat label="Romances" value={data.romanceThreads.length + (data.hooks.triangle ? 1 : 0)} colour="text-pink-400" />
            <Stat label="Rivals" value={rivals.length} colour="text-red-400" />
            <Stat
              label="Trust δ"
              value={(data.trustDelta >= 0 ? '+' : '') + data.trustDelta}
              colour={data.trustDelta >= 0 ? 'text-ui-good' : 'text-red-400'}
            />
          </div>

          <Section title="Starting Mood">
            <div className="flex flex-wrap gap-1.5">
              {moods.map(({ name, mood, stress }) => {
                const meta = moodMeta(mood, stress);
                return (
                  <span
                    key={name}
                    title={`mood ${mood}, stress ${stress}`}
                    className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${meta.colour}`}
                  >
                    <span>{meta.emoji}</span>
                    <span>{firstName(name)}</span>
                  </span>
                );
              })}
            </div>
          </Section>

          {money.length > 0 && (
            <Section title="Starting Money">
              <p className="text-[11px] text-ui-dim">
                {Math.min(...money)}–{Math.max(...money)} coins, average{' '}
                {Math.round(money.reduce((s, m) => s + m, 0) / money.length)}. Higher crime widens
                the gap.
              </p>
            </Section>
          )}

          {secrets.length > 0 && (
            <Section title="Secrets">
              <div className="space-y-1.5">
                {secrets.map((s, i) => {
                  const sm = SENSITIVITY_META[s.sensitivity] ?? SENSITIVITY_META[1];
                  return (
                    <div
                      key={`${s.template_id}-${i}`}
                      className="flex items-start gap-2 bg-ui-panel rounded-lg p-2.5 border border-ui-line"
                    >
                      <span className="text-ui-muted text-xs mt-0.5 shrink-0">🤫</span>
                      <p className="text-[11px] text-ui-text flex-1 leading-snug">{s.content}</p>
                      <span className="shrink-0 text-[9px] text-ui-muted">
                        {s.known_by_indices.length} know
                      </span>
                      <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full ${sm.colour}`}>
                        {sm.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {data.romanceThreads.length > 0 && (
            <Section title="Romance Threads">
              <div className="space-y-1.5">
                {data.romanceThreads.map((t, i) => {
                  const tension = Math.max(0, ...t.romance_values.map((v) => v.value));
                  return (
                    <div
                      key={`${t.template_id}-${i}`}
                      className="flex items-center gap-2 bg-ui-panel rounded-lg p-2.5 border border-ui-line"
                    >
                      <span className="text-pink-400 text-xs">💕</span>
                      <span className="text-[11px] text-ui-text">
                        {t.agent_indices.map(nameOf).map(firstName).join(' & ')}
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-pink-900/30 text-pink-300 border border-pink-700/40">
                        {t.romance_values.length > 1 ? 'mutual' : 'one-sided'}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <div className="w-16 h-1.5 bg-ui-raised rounded-full overflow-hidden">
                          <div className="h-full bg-pink-500 rounded-full" style={{ width: `${tension}%` }} />
                        </div>
                        <span className="text-[10px] text-ui-muted">{tension}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {rivals.length > 0 && (
            <Section title="Rival Pairs">
              <div className="space-y-1.5">
                {rivals.map(([a, b], i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 bg-ui-panel rounded-lg p-2.5 border border-ui-line"
                  >
                    <span className="text-red-400 text-xs">⚔️</span>
                    <span className="text-[11px] text-ui-text">
                      {firstName(nameOf(a))}
                      <span className="text-ui-muted mx-1">vs</span>
                      {firstName(nameOf(b))}
                    </span>
                    <span className="ml-auto text-[10px] text-ui-muted italic">
                      starts hostile and distrustful
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, colour }: { label: string; value: number | string; colour: string }) {
  return (
    <div className="bg-ui-panel rounded-lg p-3 text-center border border-ui-line">
      <div className={`text-xl font-bold ${colour}`}>{value}</div>
      <div className="text-[10px] text-ui-muted mt-0.5">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="text-xs text-ui-muted uppercase font-medium mb-2">{title}</h4>
      {children}
    </div>
  );
}
