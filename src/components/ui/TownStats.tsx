import { trpc } from "../../lib/trpc";
import { useAgents } from "../../hooks/useAgents";
import { COLORS } from "../../lib/constants";
import { describeAction } from "../../lib/actionText";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { stateCss, stateLabel } from "../../lib/stateStyle";

interface TownStatsProps {
  isOpen: boolean;
  onClose: () => void;
}

function moodColor(mood: number): string {
  if (mood >= 80) return COLORS.mood.happy;
  if (mood >= 60) return COLORS.mood.content;
  if (mood >= 40) return COLORS.mood.okay;
  if (mood >= 20) return COLORS.mood.down;
  return COLORS.mood.miserable;
}

function moodLabel(mood: number): string {
  if (mood >= 80) return "Happy";
  if (mood >= 60) return "Content";
  if (mood >= 40) return "Okay";
  if (mood >= 20) return "Down";
  return "Miserable";
}

function NeedBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] text-ui-dim w-14 text-right">{label}</div>
      <div className="flex-1 h-1.5 bg-ui-raised rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <div className="text-[10px] text-ui-muted w-6 text-right">{Math.round(value)}</div>
    </div>
  );
}

function StatCard({ label, value, color, subtitle, loading }: { label: string; value: string | number; color?: string; subtitle?: string; loading?: boolean }) {
  return (
    <div className="text-center">
      {loading ? (
        <div className="h-7 flex items-center justify-center"><Skeleton className="h-4 w-10" /></div>
      ) : (
        <div className="text-xl font-bold" style={{ color: color ?? 'var(--ui-text-primary)' }}>{value}</div>
      )}
      <div className="text-[10px] text-ui-dim uppercase">{label}</div>
      {subtitle && <div className="text-[9px] text-ui-muted">{subtitle}</div>}
    </div>
  );
}

export function TownStats({ isOpen, onClose }: TownStatsProps) {
  // Gated like the queries below: it is now invalidated every agents.all
  // update, and this component stays mounted while closed.
  const { data: economyStats } = trpc.economy.getTownStats.useQuery(undefined, { enabled: isOpen });
  const { agents } = useAgents();
  const { data: relationships } = trpc.relationships.getGraph.useQuery();
  const { data: secretNetwork } = trpc.knowledge.getSecretNetwork.useQuery(undefined, {
    enabled: isOpen,
  });
  const { data: cliques } = trpc.relationships.getCliques.useQuery(undefined, {
    enabled: isOpen,
  });

  if (!isOpen) return null;

  // --- Compute stats ---
  const agentData = agents.map((a) => ({
    id: a.id,
    name: a.name,
    mood: a.needs?.mood ?? 50,
    hunger: a.needs?.hunger ?? 50,
    energy: a.needs?.energy ?? 50,
    social: a.needs?.social ?? 50,
    stress: a.needs?.stress ?? 0,
    states: (a.activeStates ?? []).map((s) => s.type as string),
    action: a.current_action?.type ?? 'idle',
    // `plan:decomposed` / `goal:...` are decision sources, not activities (see lib/actionText.ts).
    zone: (() => {
      const z = a.current_action?.zoneActivity as string | undefined;
      return z && !z.includes(':') ? z : null;
    })(),
  }));

  const avgMood = agentData.length > 0
    ? agentData.reduce((s, a) => s + a.mood, 0) / agentData.length : 50;
  const avgHunger = agentData.length > 0
    ? agentData.reduce((s, a) => s + a.hunger, 0) / agentData.length : 50;
  const avgEnergy = agentData.length > 0
    ? agentData.reduce((s, a) => s + a.energy, 0) / agentData.length : 50;
  const avgSocial = agentData.length > 0
    ? agentData.reduce((s, a) => s + a.social, 0) / agentData.length : 50;

  // State counts
  const stateCounts: Record<string, number> = {};
  for (const a of agentData) {
    for (const s of a.states) {
      stateCounts[s] = (stateCounts[s] ?? 0) + 1;
    }
  }
  const sortedStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]);

  // Action counts. Keyed by the specific thing they're doing (fishing beats "idle")
  // and labelled in plain words rather than the raw simulation type.
  const actionCounts: Record<string, number> = {};
  for (const a of agentData) {
    const key = a.zone ?? a.action;
    actionCounts[key] = (actionCounts[key] ?? 0) + 1;
  }
  const sortedActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);

  // Relationship stats
  const rels = relationships ?? [];
  const partners = rels.filter((r) => r.status === 'partners').length;
  const bestFriends = rels.filter((r) => r.status === 'best_friends').length;
  const rivals = rels.filter((r) => r.status === 'rivals' || r.status === 'enemies').length;
  const grudges = rels.filter((r) => (r.tags as string[])?.includes('grudge')).length;

  // Agents in trouble
  const sickCount = agentData.filter(a => a.states.includes('sick')).length;
  const drunkCount = agentData.filter(a => a.states.includes('drunk')).length;
  const inDebtCount = agentData.filter(a => a.states.includes('in_debt')).length;
  const alcoholicCount = agentData.filter(a => a.states.includes('alcoholic')).length;
  const jealousCount = agentData.filter(a => a.states.includes('jealous')).length;
  const enviousCount = agentData.filter(a => a.states.includes('envious')).length;
  const depressedCount = agentData.filter(a => a.states.includes('depressed')).length;

  const ACTION_EMOJIS: Record<string, string> = {
    sleeping: '💤', eating: '🍽️', working: '🔨', talking: '💬',
    walking: '🚶', shopping: '🛒', socializing: '👋', idle: '⏸️',
    fish: '🎣', garden: '🌱', forage: '🌿', perform: '🎭', jog: '🏃', browse: '🛍️',
    rest: '🛋️', contemplate: '🌊', comfort: '🫂', cook: '🍳', watch: '👀',
  };
  /** "fish" -> "Fishing by the river"; "sleeping" -> "Sleeping". */
  const TYPE_KEYS = new Set(['sleeping', 'eating', 'working', 'talking', 'walking', 'shopping', 'socializing', 'idle']);
  const actionLabel = (key: string) =>
    describeAction(TYPE_KEYS.has(key) ? { type: key } : { type: 'idle', zoneActivity: key });

  // Widest-spread first: a secret half the town knows is the live scandal, a
  // secret one agent holds is a fuse that hasn't been lit.
  const secrets = (secretNetwork ?? [])
    .slice()
    .sort((a, b) => b.knownByCount - a.knownByCount || b.sensitivity - a.sensitivity)
    .slice(0, 10);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[600px] max-w-[95vw] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ui-line">
          <h2 className="text-sm font-bold text-ui-text">Town Dashboard</h2>
          <button onClick={onClose} className="text-ui-dim hover:text-ui-text text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Top Summary */}
        <div className="px-5 py-3 border-b border-ui-line">
          <div className="grid grid-cols-5 gap-3">
            <StatCard label="Population" value={agents.length} />
            <StatCard label="Avg Mood" value={Math.round(avgMood)} color={moodColor(avgMood)} subtitle={moodLabel(avgMood)} />
            <StatCard label="Total Coins" value={Math.floor(economyStats?.totalMoney ?? 0)} color="var(--ui-accent-gold)" loading={!economyStats} />
            <StatCard label="Partners" value={partners} color="#ec4899" />
            <StatCard label="Rivals" value={rivals + grudges} color="#ef4444" />
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-2 gap-0 border-b border-ui-line">
          {/* Left: Town Needs */}
          <div className="px-5 py-3 border-r border-ui-line">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              Town Average Needs
            </div>
            <div className="space-y-1.5">
              <NeedBar label="Mood" value={avgMood} color={moodColor(avgMood)} />
              <NeedBar label="Hunger" value={avgHunger} color={avgHunger > 50 ? '#22c55e' : avgHunger > 25 ? '#eab308' : '#ef4444'} />
              <NeedBar label="Energy" value={avgEnergy} color={avgEnergy > 50 ? '#22c55e' : avgEnergy > 25 ? '#eab308' : '#ef4444'} />
              <NeedBar label="Social" value={avgSocial} color={avgSocial > 50 ? '#22c55e' : avgSocial > 25 ? '#eab308' : '#ef4444'} />
            </div>
          </div>

          {/* Right: Current Activities */}
          <div className="px-5 py-3">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              Current Activities
            </div>
            <div className="space-y-1">
              {sortedActions.map(([action, count]) => (
                <div key={action} className="flex items-center gap-2 text-xs">
                  <span>{ACTION_EMOJIS[action] ?? '❓'}</span>
                  <span className="text-ui-text flex-1">{actionLabel(action)}</span>
                  <span className="text-ui-muted font-mono">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Active States */}
        {sortedStates.length > 0 && (
          <div className="px-5 py-3 border-b border-ui-line">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              Active States
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sortedStates.map(([state, count]) => (
                <span
                  key={state}
                  className="text-[10px] px-2 py-0.5 rounded-full border font-medium"
                  style={{
                    color: stateCss(state, '#9ca3af'),
                    borderColor: stateCss(state, '#9ca3af'),
                    backgroundColor: stateCss(state, '#9ca3af') + '20',
                  }}
                >
                  {stateLabel(state)} × {count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Trouble Alerts */}
        {(sickCount > 0 || drunkCount > 0 || inDebtCount > 0 || alcoholicCount > 0 || jealousCount > 0 || enviousCount > 0 || depressedCount > 0) && (
          <div className="px-5 py-3 border-b border-ui-line">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              ⚠️ Trouble Alerts
            </div>
            <div className="grid grid-cols-3 gap-2">
              {sickCount > 0 && (
                <div className="text-xs text-ui-warn">🤒 {sickCount} sick</div>
              )}
              {drunkCount > 0 && (
                <div className="text-xs text-amber-400">🥴 {drunkCount} drunk</div>
              )}
              {alcoholicCount > 0 && (
                <div className="text-xs text-orange-400">🍺 {alcoholicCount} alcoholic</div>
              )}
              {inDebtCount > 0 && (
                <div className="text-xs text-ui-bad">💰 {inDebtCount} in debt</div>
              )}
              {jealousCount > 0 && (
                <div className="text-xs text-pink-400">😒 {jealousCount} jealous</div>
              )}
              {enviousCount > 0 && (
                <div className="text-xs text-yellow-300">😑 {enviousCount} envious</div>
              )}
              {depressedCount > 0 && (
                <div className="text-xs text-indigo-400">😞 {depressedCount} depressed</div>
              )}
            </div>
          </div>
        )}

        {/* Social Overview */}
        <div className="px-5 py-3 border-b border-ui-line">
          <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
            Social Overview
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-lg font-bold text-pink-400">{partners}</div>
              <div className="text-[9px] text-ui-muted">Partners</div>
            </div>
            <div>
              <div className="text-lg font-bold text-ui-blue">{bestFriends}</div>
              <div className="text-[9px] text-ui-muted">Best Friends</div>
            </div>
            <div>
              <div className="text-lg font-bold text-ui-bad">{rivals}</div>
              <div className="text-[9px] text-ui-muted">Rivals</div>
            </div>
            <div>
              <div className="text-lg font-bold text-red-800">{grudges}</div>
              <div className="text-[9px] text-ui-muted">Grudges</div>
            </div>
          </div>
        </div>

        {/* Social Circles */}
        {(cliques === undefined || cliques.length > 0) && (
          <div className="px-5 py-3 border-b border-ui-line">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              👥 Social Circles
            </div>
            {cliques === undefined && (
              <div className="space-y-1.5" role="status" aria-label="Loading social circles">
                <Skeleton className="h-3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}
            <div className="space-y-1.5">
              {(cliques ?? []).map((clique) => (
                <div key={clique.id}>
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] text-ui-text flex-1 truncate">{clique.name}</div>
                    <div className="w-16 h-1.5 bg-ui-raised rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-ui-blue"
                        style={{ width: `${clique.cohesion * 100}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-ui-muted w-10 text-right">
                      {clique.members.length}
                    </div>
                  </div>
                  <div className="text-[10px] text-ui-muted truncate">
                    {clique.memberNames.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Town Secrets */}
        <div className="px-5 py-3 border-b border-ui-line">
          <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
            🤫 Town Secrets
          </div>
          {secretNetwork === undefined ? (
            <div className="space-y-1.5" role="status" aria-label="Loading secrets">
              <Skeleton className="h-3" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : secrets.length === 0 ? (
            <EmptyState compact icon="🕊" title="No secrets are going around." hint="Rumours and confidences, and how far each has spread, are listed here." />
          ) : (
            <div className="space-y-1">
              {secrets.map((secret) => {
                const spread = secret.totalAgents > 0
                  ? secret.knownByCount / secret.totalAgents
                  : 0;
                return (
                  <div key={secret.id} className="flex items-center gap-2">
                    {secret.isPublic && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded-sm bg-ui-bad/20 text-ui-bad shrink-0">
                        Public
                      </span>
                    )}
                    <div
                      className="text-[11px] text-ui-text flex-1 truncate"
                      title={`${secret.content}\nKnown by: ${secret.knownByNames.join(', ')}`}
                    >
                      {secret.content}
                    </div>
                    <div className="w-16 h-1.5 bg-ui-raised rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${spread * 100}%`,
                          backgroundColor: secret.sensitivity >= 3 ? '#ef4444' : '#f59e0b',
                        }}
                      />
                    </div>
                    <div className="text-[10px] text-ui-muted w-10 text-right">
                      {secret.knownByCount}/{secret.totalAgents}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Per-agent mood breakdown */}
        <div className="px-5 py-3">
          <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
            Agent Wellbeing
          </div>
          <div className="space-y-1">
            {agentData
              .slice()
              .sort((a, b) => a.mood - b.mood)
              .map((agent) => (
                <div key={agent.id} className="flex items-center gap-2">
                  <div className="text-[11px] text-ui-text w-28 truncate">{agent.name}</div>
                  <div className="flex-1 h-1.5 bg-ui-raised rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${agent.mood}%`, backgroundColor: moodColor(agent.mood) }}
                    />
                  </div>
                  <div className="text-[10px] text-ui-muted w-6 text-right">{Math.round(agent.mood)}</div>
                  {agent.states.length > 0 && (
                    <div className="flex gap-0.5 w-16 justify-end">
                      {agent.states.slice(0, 3).map((s: string) => (
                        <span
                          key={s}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: stateCss(s, '#6b7280') }}
                          title={s}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
