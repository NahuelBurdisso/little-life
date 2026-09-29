import type { ReactNode } from "react";
import { useWorldState } from "../../hooks/useWorldState";
import { useAchievementState, useChallenges } from "../../hooks/useChallenges";
import { gameMinutes } from "../../../server/lib/gameClock";
import {
  CHALLENGE_KINDS, daysLeft, MINUTES_PER_DAY, type Challenge, type Difficulty,
} from "../../../server/lib/challenges/catalog";
import { ACHIEVEMENTS, counterProgress } from "../../lib/achievements";

/**
 * The Journal's 🏆 tab: this town's challenges (running, on offer, finished)
 * and the player's achievements across every town.
 *
 * Challenges are optional: nothing in the game asks the player to open this
 * tab, so it reads like a noticeboard — what you are working on first, then
 * today's three offers, then the trophy shelf, then what happened to the old ones.
 */

interface Props {
  agents: ReadonlyArray<{ id: number | string; name: string }>;
  onSelectAgent: (agentId: string) => void;
}

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: "text-ui-good border-ui-good/50",
  medium: "text-ui-warn border-ui-warn/50",
  hard: "text-ui-bad border-ui-bad/50",
};

const ENDED_ICON: Record<string, string> = { completed: "✅", failed: "❌", expired: "⌛", abandoned: "🏳" };

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="px-4 py-3 border-b border-ui-line last:border-b-0">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-ui-gold mb-2 flex items-baseline gap-2">
        {title}
        {aside && <span className="font-normal normal-case tracking-normal text-ui-muted">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function DifficultyChip({ d }: { d: Difficulty }) {
  return <span className={`text-[9px] uppercase tracking-wide border px-1 ${DIFFICULTY_STYLE[d]}`}>{d}</span>;
}

function People({ ids, names, onSelectAgent }: { ids: number[]; names: Map<string, string>; onSelectAgent: Props["onSelectAgent"] }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelectAgent(String(id))}
          className="text-[10px] px-1.5 py-0.5 border border-ui-line text-ui-dim hover:text-ui-text hover:border-ui-line-accent hover:bg-ui-hover"
          title="Show them on the map"
        >
          👁 {names.get(String(id)) ?? `#${id}`}
        </button>
      ))}
    </div>
  );
}

export function ChallengesView({ agents, onSelectAgent }: Props) {
  const { view, isLoading, choose, abandon, busy } = useChallenges();
  const achievements = useAchievementState();
  const { world } = useWorldState();
  const now = world?.time ? gameMinutes(world.time) : view?.nowMinute ?? 0;
  const names = new Map(agents.map((a) => [String(a.id), a.name.split(" ")[0]]));

  if (isLoading && !view) return <div className="p-6 text-xs text-ui-dim">Loading challenges…</div>;

  const active = view?.active ?? [];
  const offers = view?.offers ?? [];
  const history = view?.history ?? [];
  const maxActive = view?.maxActive ?? 3;
  const full = active.length >= maxActive;
  const unlockedCount = ACHIEVEMENTS.filter((a) => achievements.unlocked[a.id] != null).length;

  return (
    <div className="text-xs text-ui-text">
      <Section title="Running" aside={`${active.length} of ${maxActive}`}>
        {active.length === 0 ? (
          <p className="text-ui-dim">
            No challenge running. They are optional goals for this town — pick one below, then meddle to make it happen.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((c) => (
              <ActiveCard key={c.id} c={c} now={now} names={names} onSelectAgent={onSelectAgent} onAbandon={() => abandon(c)} busy={busy} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="On offer" aside="new offers each game day">
        {offers.length === 0 ? (
          <p className="text-ui-dim">Nothing on offer right now — come back tomorrow.</p>
        ) : (
          <ul className="space-y-2">
            {offers.map((c) => {
              const def = CHALLENGE_KINDS[c.kind];
              const same = active.some((a) => a.kind === c.kind);
              const blocked = full || same;
              return (
                <li key={c.id} className="border border-ui-line bg-ui-raised p-2 flex gap-2 items-start">
                  <span className="text-lg leading-none" aria-hidden="true">{def.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{def.name}</span>
                      <DifficultyChip d={c.difficulty} />
                      <span className="text-ui-muted">{c.durationDays} {c.durationDays === 1 ? "day" : "days"}</span>
                    </div>
                    <p className="text-ui-dim mt-0.5">{c.goal}</p>
                    <People ids={c.agentIds} names={names} onSelectAgent={onSelectAgent} />
                  </div>
                  <button
                    type="button"
                    disabled={blocked || busy}
                    onClick={() => choose(c)}
                    title={full ? `You can run ${maxActive} at a time` : same ? "You are already running one like it" : "Accept this challenge"}
                    className="shrink-0 px-2 py-1 border border-ui-gold text-ui-gold hover:bg-ui-gold hover:text-ui-deep disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ui-gold"
                  >
                    Accept
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Achievements" aside={`${unlockedCount} of ${ACHIEVEMENTS.length} · across every town`}>
        <ul className="grid grid-cols-2 gap-1.5">
          {ACHIEVEMENTS.map((a) => {
            const at = achievements.unlocked[a.id];
            const p = counterProgress(a, achievements);
            return (
              <li
                key={a.id}
                className={`border p-1.5 flex gap-2 items-center ${at != null ? "border-ui-gold/60 bg-ui-raised" : "border-ui-line opacity-60"}`}
                title={at != null ? `Unlocked ${new Date(at).toLocaleDateString()}` : "Locked"}
              >
                <span className={`text-base leading-none ${at != null ? "" : "grayscale"}`} aria-hidden="true">{at != null ? a.icon : "🔒"}</span>
                <div className="min-w-0">
                  <div className={`font-bold truncate ${at != null ? "text-ui-gold" : "text-ui-dim"}`}>{a.name}</div>
                  <div className="text-[10px] text-ui-muted truncate">
                    {a.how}
                    {p && at == null ? ` (${p.value}/${p.goal})` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      {history.length > 0 && (
        <Section title="History">
          <ul className="space-y-1">
            {history.map((c) => (
              <li key={c.id} className="flex gap-2 items-baseline">
                <span aria-hidden="true">{ENDED_ICON[c.status] ?? "•"}</span>
                <span className="font-bold shrink-0">{CHALLENGE_KINDS[c.kind].name}</span>
                <span className="text-ui-dim min-w-0 truncate" title={`${c.goal} — ${c.outcome ?? ""}`}>
                  {c.goal}{c.outcome ? ` — ${c.outcome}` : ""}
                </span>
                {c.endedAt != null && (
                  <span className="ml-auto shrink-0 text-ui-muted">day {Math.floor(c.endedAt / MINUTES_PER_DAY)}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ActiveCard({
  c, now, names, onSelectAgent, onAbandon, busy,
}: {
  c: Challenge;
  now: number;
  names: Map<string, string>;
  onSelectAgent: Props["onSelectAgent"];
  onAbandon: () => void;
  busy: boolean;
}) {
  const def = CHALLENGE_KINDS[c.kind];
  const left = daysLeft(c.deadline, now);
  const p = c.progress;
  const pct = p && p.target > 0 ? Math.max(0, Math.min(100, (p.value / p.target) * 100)) : 0;
  return (
    <li className="border border-ui-gold/50 bg-ui-raised p-2">
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none" aria-hidden="true">{def.icon}</span>
        <span className="font-bold">{def.name}</span>
        <DifficultyChip d={c.difficulty} />
        <span className={`ml-auto ${left <= 1 ? "text-ui-warn" : "text-ui-muted"}`}>
          {left === 0 ? "ends this hour" : `${left} ${left === 1 ? "day" : "days"} left`}
        </span>
        <button
          type="button"
          onClick={onAbandon}
          disabled={busy}
          className="text-ui-muted hover:text-ui-bad px-1"
          title="Abandon this challenge"
          aria-label={`Abandon ${def.name}`}
        >
          🏳
        </button>
      </div>
      <p className="text-ui-dim mt-1">{c.goal}</p>
      {p && (
        <div className="mt-1.5">
          <div className="h-1.5 bg-ui-deep border border-ui-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-ui-gold" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] text-ui-muted mt-0.5">{p.label}</div>
        </div>
      )}
      <People ids={c.agentIds} names={names} onSelectAgent={onSelectAgent} />
    </li>
  );
}
