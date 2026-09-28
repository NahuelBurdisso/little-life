import { trpc } from "../../lib/trpc";
import { useAgents } from "../../hooks/useAgents";
import { COLORS } from "../../lib/constants";

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
      <div className="text-[10px] text-gray-400 w-14 text-right">{label}</div>
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <div className="text-[10px] text-gray-500 w-6 text-right">{Math.round(value)}</div>
    </div>
  );
}

function StatCard({ label, value, color, subtitle }: { label: string; value: string | number; color?: string; subtitle?: string }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold" style={{ color: color ?? '#fff' }}>{value}</div>
      <div className="text-[10px] text-gray-400 uppercase">{label}</div>
      {subtitle && <div className="text-[9px] text-gray-500">{subtitle}</div>}
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
  const agentData = agents.map((a: any) => ({
    id: a.id,
    name: a.name,
    mood: a.needs?.mood ?? 50,
    hunger: a.needs?.hunger ?? 50,
    energy: a.needs?.energy ?? 50,
    social: a.needs?.social ?? 50,
    stress: a.needs?.stress ?? 0,
    states: (a.activeStates ?? []).map((s: any) => s.type as string),
    action: (a.current_action as any)?.type ?? 'idle',
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

  // Action counts
  const actionCounts: Record<string, number> = {};
  for (const a of agentData) {
    actionCounts[a.action] = (actionCounts[a.action] ?? 0) + 1;
  }
  const sortedActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);

  // Relationship stats
  const rels = relationships ?? [];
  const partners = rels.filter((r: any) => r.status === 'partners').length;
  const bestFriends = rels.filter((r: any) => r.status === 'best_friends').length;
  const rivals = rels.filter((r: any) => r.status === 'rivals' || r.status === 'enemies').length;
  const grudges = rels.filter((r: any) => (r.tags as string[])?.includes('grudge')).length;

  // Agents in trouble
  const sickCount = agentData.filter(a => a.states.includes('sick')).length;
  const drunkCount = agentData.filter(a => a.states.includes('drunk')).length;
  const inDebtCount = agentData.filter(a => a.states.includes('in_debt')).length;
  const alcoholicCount = agentData.filter(a => a.states.includes('alcoholic')).length;
  const jealousCount = agentData.filter(a => a.states.includes('jealous')).length;
  const depressedCount = agentData.filter(a => a.states.includes('depressed')).length;

  const ACTION_EMOJIS: Record<string, string> = {
    sleeping: '💤', eating: '🍽️', working: '🔨', talking: '💬',
    walking: '🚶', shopping: '🛒', socializing: '👋', idle: '⏸️',
  };

  // Widest-spread first: a secret half the town knows is the live scandal, a
  // secret one agent holds is a fuse that hasn't been lit.
  const secrets = (secretNetwork ?? [])
    .slice()
    .sort((a, b) => b.knownByCount - a.knownByCount || b.sensitivity - a.sensitivity)
    .slice(0, 10);

  const STATE_COLORS: Record<string, string> = {
    angry: '#ef4444', jealous: '#f43f5e', heartbroken: '#fb7185', infatuated: '#ec4899',
    drunk: '#f59e0b', alcoholic: '#d97706', stressed: '#f97316', in_debt: '#ea580c',
    depressed: '#6366f1', lonely: '#8b5cf6', sick: '#a3e635', hungover: '#84cc16',
    euphoric: '#10b981', confident: '#14b8a6', grieving: '#6b7280',
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[600px] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-bold text-white">Town Dashboard</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Top Summary */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="grid grid-cols-5 gap-3">
            <StatCard label="Population" value={agents.length} />
            <StatCard label="Avg Mood" value={Math.round(avgMood)} color={moodColor(avgMood)} subtitle={moodLabel(avgMood)} />
            <StatCard label="Total Coins" value={Math.floor(economyStats?.totalMoney ?? 0)} color="#eab308" />
            <StatCard label="Partners" value={partners} color="#ec4899" />
            <StatCard label="Rivals" value={rivals + grudges} color="#ef4444" />
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-2 gap-0 border-b border-gray-700">
          {/* Left: Town Needs */}
          <div className="px-5 py-3 border-r border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
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
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              Current Activities
            </div>
            <div className="space-y-1">
              {sortedActions.map(([action, count]) => (
                <div key={action} className="flex items-center gap-2 text-xs">
                  <span>{ACTION_EMOJIS[action] ?? '❓'}</span>
                  <span className="text-gray-300 capitalize flex-1">{action}</span>
                  <span className="text-gray-500 font-mono">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Active States */}
        {sortedStates.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              Active States
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sortedStates.map(([state, count]) => (
                <span
                  key={state}
                  className="text-[10px] px-2 py-0.5 rounded-full border font-medium"
                  style={{
                    color: STATE_COLORS[state] ?? '#9ca3af',
                    borderColor: STATE_COLORS[state] ?? '#9ca3af',
                    backgroundColor: (STATE_COLORS[state] ?? '#9ca3af') + '20',
                  }}
                >
                  {state.replace(/_/g, ' ')} × {count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Trouble Alerts */}
        {(sickCount > 0 || drunkCount > 0 || inDebtCount > 0 || alcoholicCount > 0 || jealousCount > 0 || depressedCount > 0) && (
          <div className="px-5 py-3 border-b border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              ⚠️ Trouble Alerts
            </div>
            <div className="grid grid-cols-3 gap-2">
              {sickCount > 0 && (
                <div className="text-xs text-yellow-300">🤒 {sickCount} sick</div>
              )}
              {drunkCount > 0 && (
                <div className="text-xs text-amber-400">🥴 {drunkCount} drunk</div>
              )}
              {alcoholicCount > 0 && (
                <div className="text-xs text-orange-400">🍺 {alcoholicCount} alcoholic</div>
              )}
              {inDebtCount > 0 && (
                <div className="text-xs text-red-400">💰 {inDebtCount} in debt</div>
              )}
              {jealousCount > 0 && (
                <div className="text-xs text-pink-400">😒 {jealousCount} jealous</div>
              )}
              {depressedCount > 0 && (
                <div className="text-xs text-indigo-400">😞 {depressedCount} depressed</div>
              )}
            </div>
          </div>
        )}

        {/* Social Overview */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
            Social Overview
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-lg font-bold text-pink-400">{partners}</div>
              <div className="text-[9px] text-gray-500">Partners</div>
            </div>
            <div>
              <div className="text-lg font-bold text-blue-400">{bestFriends}</div>
              <div className="text-[9px] text-gray-500">Best Friends</div>
            </div>
            <div>
              <div className="text-lg font-bold text-red-400">{rivals}</div>
              <div className="text-[9px] text-gray-500">Rivals</div>
            </div>
            <div>
              <div className="text-lg font-bold text-red-800">{grudges}</div>
              <div className="text-[9px] text-gray-500">Grudges</div>
            </div>
          </div>
        </div>

        {/* Social Circles */}
        {(cliques?.length ?? 0) > 0 && (
          <div className="px-5 py-3 border-b border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              👥 Social Circles
            </div>
            <div className="space-y-1.5">
              {cliques!.map((clique) => (
                <div key={clique.id}>
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] text-white flex-1 truncate">{clique.name}</div>
                    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-sky-400"
                        style={{ width: `${clique.cohesion * 100}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500 w-10 text-right">
                      {clique.members.length}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-500 truncate">
                    {clique.memberNames.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Town Secrets */}
        {secrets.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              🤫 Town Secrets
            </div>
            <div className="space-y-1">
              {secrets.map((secret) => {
                const spread = secret.totalAgents > 0
                  ? secret.knownByCount / secret.totalAgents
                  : 0;
                return (
                  <div key={secret.id} className="flex items-center gap-2">
                    {secret.isPublic && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded bg-red-500/20 text-red-300 shrink-0">
                        Public
                      </span>
                    )}
                    <div
                      className="text-[11px] text-gray-300 flex-1 truncate"
                      title={`${secret.content}\nKnown by: ${secret.knownByNames.join(', ')}`}
                    >
                      {secret.content}
                    </div>
                    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${spread * 100}%`,
                          backgroundColor: secret.sensitivity >= 3 ? '#ef4444' : '#f59e0b',
                        }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500 w-10 text-right">
                      {secret.knownByCount}/{secret.totalAgents}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-agent mood breakdown */}
        <div className="px-5 py-3">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
            Agent Wellbeing
          </div>
          <div className="space-y-1">
            {agentData
              .slice()
              .sort((a, b) => a.mood - b.mood)
              .map((agent) => (
                <div key={agent.id} className="flex items-center gap-2">
                  <div className="text-[11px] text-white w-28 truncate">{agent.name}</div>
                  <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${agent.mood}%`, backgroundColor: moodColor(agent.mood) }}
                    />
                  </div>
                  <div className="text-[10px] text-gray-500 w-6 text-right">{Math.round(agent.mood)}</div>
                  {agent.states.length > 0 && (
                    <div className="flex gap-0.5 w-16 justify-end">
                      {agent.states.slice(0, 3).map((s: string) => (
                        <span
                          key={s}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: STATE_COLORS[s] ?? '#6b7280' }}
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
