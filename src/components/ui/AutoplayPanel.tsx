import type { ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { pushToast } from "../../lib/toast";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import {
  POPULATION_TARGET_MAX,
  POPULATION_TARGET_MIN,
  STORYTELLERS,
  matchStoryteller,
  type StorytellerPreset,
} from "../../../server/data/rulesCatalog";

interface AutoplayPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Nothing emits a dirty-channel for autoplay reports (tick.ts says so), so an open panel polls. */
const POLL_MS = 3000;

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-ui-bad/25 text-ui-bad border-ui-bad/40",
  high: "bg-ui-bad/15 text-ui-bad border-ui-bad/30",
  medium: "bg-ui-warn/15 text-ui-warn border-ui-warn/30",
  low: "bg-ui-raised text-ui-dim border-ui-line",
};

const TREND_LABEL: Record<string, { glyph: string; text: string; className: string }> = {
  improving: { glyph: "▼", text: "getting livelier", className: "text-ui-good" },
  stable: { glyph: "■", text: "steady", className: "text-ui-dim" },
  declining: { glyph: "▲", text: "getting duller", className: "text-ui-bad" },
};

function pretty(s: string): string {
  return s.replace(/_/g, " ");
}

function Toggle({
  checked,
  pending,
  onChange,
  label,
  hint,
  inactive = false,
}: {
  checked: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
  /** The setting is kept but does nothing right now (its parent switch is off). */
  inactive?: boolean;
}) {
  // The stored value is kept (it comes back when the parent goes on), but a
  // switch that does nothing must not read as ON: show it off and lock it.
  const shown = checked && !inactive;
  return (
    <div className={`flex items-center justify-between gap-3 transition-opacity ${inactive ? "opacity-45" : ""}`}>
      <div className="min-w-0">
        <div className="text-xs text-ui-text">{label}</div>
        <div className="text-[10px] text-ui-muted leading-snug">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label}
        disabled={pending || inactive}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full border shrink-0 transition-colors disabled:opacity-50 ${
          inactive ? "cursor-not-allowed" : ""
        } ${shown ? "bg-ui-gold/30 border-ui-gold" : "bg-ui-raised border-ui-line"}`}
      >
        <span
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${
            shown ? "left-[22px] bg-ui-gold" : "left-0.5 bg-ui-dim"
          }`}
        />
      </button>
    </div>
  );
}

/** A 0-100 score as a labelled bar; `threshold` draws the line boredom has to cross to trigger nudges. */
function Gauge({
  label,
  value,
  goodIsHigh,
  threshold,
}: {
  label: string;
  value: number;
  goodIsHigh: boolean;
  threshold?: number;
}) {
  const v = Math.max(0, Math.min(100, value));
  const quality = goodIsHigh ? v : 100 - v;
  const color = quality >= 65 ? "var(--ui-positive)" : quality >= 40 ? "var(--ui-warning)" : "var(--ui-negative)";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px] mb-1">
        <span className="text-ui-dim uppercase tracking-wide">{label}</span>
        <span className="text-ui-text font-semibold text-xs">{Math.round(v)}</span>
      </div>
      <div className="relative h-2 bg-ui-raised rounded-sm overflow-hidden">
        <div className="h-full transition-all duration-500" style={{ width: `${v}%`, backgroundColor: color }} />
        {threshold != null && (
          <div
            className="absolute top-0 bottom-0 w-px bg-ui-text/70"
            style={{ left: `${threshold}%` }}
            title={`Nudges start above ${threshold}`}
          />
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h3 className="text-[10px] uppercase tracking-wider text-ui-dim font-medium">{children}</h3>
      {right}
    </div>
  );
}

/**
 * The Storyteller: one click sets how dramatic, sickly and contagious the town
 * is (world.setRules, saved with the world) and how eagerly autoplay pokes it
 * (autoplay.configure, process-wide). The two live in different places on the
 * server, so a preset is two mutations; the badge re-derives which preset is
 * running from both, and reads "Custom" once either is changed by hand.
 */
function StorytellerSection({ poll }: { poll: number | false }) {
  const utils = trpc.useUtils();
  const { data: rules } = trpc.world.getRules.useQuery(undefined, { refetchInterval: poll });
  const { data: config } = trpc.autoplay.getConfig.useQuery(undefined, { refetchInterval: poll });
  const setRules = trpc.world.setRules.useMutation();
  // Its own instance: the panel's `configure` toasts "Autoplay on/off", and a
  // preset should answer with one toast of its own.
  const configure = trpc.autoplay.configure.useMutation();
  const pending = setRules.isPending || configure.isPending;

  const current =
    rules && config
      ? matchStoryteller(rules, { enabled: config.ENABLED, boredThreshold: config.BOREDOM_THRESHOLD })
      : undefined;

  async function apply(preset: StorytellerPreset) {
    try {
      const res = await setRules.mutateAsync(preset.rules);
      if (!res.ok) {
        pushToast(`Couldn't set the storyteller — ${res.error}.`, "warning", preset.icon);
        return;
      }
      await configure.mutateAsync({
        enabled: preset.autoplay.enabled,
        boredThreshold: preset.autoplay.boredThreshold,
        // A preset that turns the watcher on means it to act, not just watch; one that
        // leaves it off must not keep a stale "nudge when bored" ON behind it.
        autoNudge: preset.autoplay.enabled,
      });
      pushToast(`Storyteller: ${preset.label}. ${preset.blurb}`, "success", preset.icon);
    } catch {
      pushToast("Couldn't change the storyteller — is the server running?", "error");
    } finally {
      void utils.world.getRules.invalidate();
      void utils.autoplay.getConfig.invalidate();
    }
  }

  const currentLabel =
    current === undefined ? null : current === null ? "Custom" : STORYTELLERS.find((p) => p.id === current)!.label;

  return (
    <div className="px-5 py-3 border-b border-ui-line">
      <SectionTitle
        right={
          currentLabel && (
            <span
              className={`text-[10px] px-1.5 py-0.5 border ${
                current ? "bg-ui-gold/15 text-ui-gold border-ui-gold/40" : "bg-ui-raised text-ui-muted border-ui-line"
              }`}
              title={current ? "The town is running this preset" : "Rules or autoplay were changed by hand"}
            >
              {currentLabel}
            </span>
          )
        }
      >
        Storyteller
      </SectionTitle>
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Storyteller">
        {STORYTELLERS.map((p) => {
          const active = current === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending || !rules || !config}
              onClick={() => void apply(p)}
              title={p.blurb}
              className={`text-left px-2 py-1.5 border transition-colors disabled:opacity-50 ${
                active
                  ? "bg-ui-gold/10 border-ui-gold text-ui-text"
                  : "bg-ui-raised border-ui-line text-ui-dim hover:border-ui-line-accent hover:text-ui-text"
              }`}
            >
              <div className="text-xs font-medium">
                {p.icon} {p.label}
              </div>
              <div className="text-[9px] text-ui-muted leading-snug mt-0.5">
                drama {p.rules.dramaIntensity} · {p.autoplay.enabled ? `nudges > ${p.autoplay.boredThreshold}` : "no nudges"}
              </div>
            </button>
          );
        })}
      </div>
      {rules && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {[
            ["drama", rules.dramaIntensity],
            ["sickness", rules.sicknessRate],
            ["contagion", rules.contagionRate],
            ["death", rules.deathEnabled ? "on" : "off"],
          ].map(([k, v]) => (
            <span key={k} className="text-[10px] px-1.5 py-0.5 bg-ui-raised border border-ui-line text-ui-dim">
              <span className="text-ui-muted">{k}</span> {v}
            </span>
          ))}
        </div>
      )}
      {rules && <PopulationRow poll={poll} flowOn={rules.populationFlow} />}
    </div>
  );
}

/**
 * Population flow (server/lib/populationFlow.ts): whether residents move away
 * and strangers move in on their own, and the size newcomers fill the town
 * back up to. Not part of any preset: like death, it changes who is in the
 * story, which is the player's call.
 */
function PopulationRow({ poll, flowOn }: { poll: number | false; flowOn: boolean }) {
  const utils = trpc.useUtils();
  const { data: pop } = trpc.world.getPopulation.useQuery(undefined, { refetchInterval: poll });
  const setRules = trpc.world.setRules.useMutation({
    onSettled: () => {
      void utils.world.getRules.invalidate();
      void utils.world.getPopulation.invalidate();
    },
    onError: () => pushToast("Couldn't change the population rule — is the server running?", "error"),
  });
  const pending = setRules.isPending;
  const step = (delta: number) => {
    if (!pop) return;
    const next = Math.max(POPULATION_TARGET_MIN, Math.min(POPULATION_TARGET_MAX, pop.target + delta));
    if (next !== pop.target) setRules.mutate({ populationTarget: next });
  };
  return (
    <div className="mt-3 space-y-1.5">
      <Toggle
        checked={flowOn}
        pending={pending}
        onChange={(next) => setRules.mutate({ populationFlow: next })}
        label="Comings & goings"
        hint="Unhappy residents may move away; strangers take empty houses."
      />
      {pop && (
        <div className={`flex items-center justify-between text-[10px] transition-opacity ${flowOn ? "" : "opacity-45"}`}>
          <span className="text-ui-muted">
            {pop.living} living · never below {pop.floor}
          </span>
          <span className="flex items-center gap-1">
            <span className="text-ui-muted">target</span>
            <button
              type="button"
              aria-label="Lower the target population"
              disabled={pending || !flowOn || pop.target <= POPULATION_TARGET_MIN}
              onClick={() => step(-1)}
              className="w-5 h-5 border border-ui-line bg-ui-raised text-ui-dim hover:text-ui-text disabled:opacity-40"
            >
              −
            </button>
            <span className="w-5 text-center text-ui-text font-semibold text-xs">{pop.target}</span>
            <button
              type="button"
              aria-label="Raise the target population"
              disabled={pending || !flowOn || pop.target >= Math.min(POPULATION_TARGET_MAX, pop.cap)}
              onClick={() => step(1)}
              className="w-5 h-5 border border-ui-line bg-ui-raised text-ui-dim hover:text-ui-text disabled:opacity-40"
            >
              +
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * The autoplay controls the router has always had but the UI never exposed
 * (server/routers/autoplay.ts): a switch for the boredom watcher + auto-nudger,
 * its current settings, and what its latest analysis window concluded.
 */
export function AutoplayPanel({ isOpen, onClose }: AutoplayPanelProps) {
  const utils = trpc.useUtils();
  const poll = isOpen ? POLL_MS : false;
  const { data: config } = trpc.autoplay.getConfig.useQuery(undefined, { refetchInterval: poll });
  const { data: report } = trpc.autoplay.getReport.useQuery(undefined, { enabled: isOpen, refetchInterval: poll });
  const { data: history } = trpc.autoplay.getHistory.useQuery({ windows: 24 }, { enabled: isOpen, refetchInterval: poll });
  const { data: profiles } = trpc.autoplay.getAgentProfiles.useQuery(undefined, { enabled: isOpen, refetchInterval: poll });

  const configure = trpc.autoplay.configure.useMutation({
    onSuccess: (next, vars) => {
      void utils.autoplay.getConfig.invalidate();
      if (vars.enabled !== undefined) {
        pushToast(
          next.ENABLED ? "Autoplay on — watching the town for boredom." : "Autoplay off.",
          next.ENABLED ? "success" : "info",
          "🎞",
        );
      } else if (vars.autoNudge !== undefined) {
        pushToast(next.AUTO_NUDGE ? "Auto-nudges on." : "Auto-nudges off — autoplay will only watch.", "info", "🎞");
      }
    },
    onError: () => pushToast("Couldn't change autoplay — is the server running?", "error"),
  });

  if (!isOpen) return null;

  const enabled = config?.ENABLED ?? false;
  const pending = configure.isPending;

  // Newest first, across every retained window: the latest report only holds
  // what that one window did, and nudges are rare (cooldown ~2 game hours).
  const nudges = (history ?? [])
    .flatMap((r) => r.nudgesApplied.map((n) => ({ ...n, day: r.window.day, hour: r.window.gameHour })))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6);

  // Built from the report itself rather than getAgentProfiles' issue counts: the two
  // queries poll independently, so right after a new window the profile list could
  // still describe the previous one and show nobody flagged next to a diagnosis that
  // names someone. Profiles are only used to look up names.
  const nameById = new Map((profiles ?? []).map((p) => [p.agentId, p.name]));
  const issuesByAgent = new Map<number, string[]>();
  for (const d of report?.diagnoses ?? []) {
    for (const id of d.affectedAgents ?? []) issuesByAgent.set(id, [...(issuesByAgent.get(id) ?? []), d.type]);
  }
  const flagged = [...issuesByAgent.entries()]
    .map(([agentId, issues]) => ({ agentId, name: nameById.get(agentId) ?? `Resident ${agentId}`, issues, issueCount: issues.length }))
    .sort((a, b) => b.issueCount - a.issueCount);
  const trend = report ? TREND_LABEL[report.trend] : null;
  const diagnoses = report
    ? [...report.diagnoses].sort(
        (a, b) => ["low", "medium", "high", "critical"].indexOf(b.severity) - ["low", "medium", "high", "critical"].indexOf(a.severity),
      )
    : [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[520px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Autoplay"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ui-line shrink-0">
          <div>
            <h2 className="text-sm font-bold text-ui-text flex items-center gap-2">
              🎞 Autoplay
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 border ${
                  enabled ? "bg-ui-good/15 text-ui-good border-ui-good/40" : "bg-ui-raised text-ui-muted border-ui-line"
                }`}
              >
                {enabled ? "watching" : "off"}
              </span>
            </h2>
            <p className="text-[10px] text-ui-muted mt-0.5">
              Notices when the town gets dull and pokes it — so you can leave it running.
            </p>
          </div>
          <button onClick={onClose} className="text-ui-dim hover:text-ui-text text-lg leading-none" aria-label="Close">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <StorytellerSection poll={poll} />

          {/* Controls */}
          <div className="px-5 py-3 border-b border-ui-line space-y-3">
            {!config ? (
              <div className="space-y-2" role="status" aria-label="Loading">
                <Skeleton className="h-5" />
                <Skeleton className="h-5" />
              </div>
            ) : (
              <>
                <Toggle
                  checked={config.ENABLED}
                  pending={pending}
                  onChange={(next) => configure.mutate({ enabled: next })}
                  label="Watch the town"
                  hint="Measures conversations, drama and variety once per window."
                />
                <Toggle
                  checked={config.AUTO_NUDGE}
                  pending={pending}
                  onChange={(next) => configure.mutate({ autoNudge: next })}
                  label="Nudge when bored"
                  // Nudges come out of the window report, so without watching there is nothing to act on.
                  inactive={!config.ENABLED}
                  hint={config.ENABLED
                    ? "Starts a conversation or event if boredom crosses the threshold."
                    : "Needs \"Watch the town\" on — nudges act on its reports."}
                />
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {[
                    ["window", `${config.WINDOW_MINUTES} game min`],
                    ["threshold", `boredom > ${config.BOREDOM_THRESHOLD}`],
                    ["limit", `${config.MAX_NUDGES_PER_DAY} nudges / day`],
                  ].map(([k, v]) => (
                    <span key={k} className="text-[10px] px-1.5 py-0.5 bg-ui-raised border border-ui-line text-ui-dim">
                      <span className="text-ui-muted">{k}</span> {v}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Latest report */}
          {!report ? (
            <EmptyState
              icon={enabled ? "⏳" : "💤"}
              title={enabled ? "Waiting for the first window…" : "Autoplay is off"}
              hint={
                enabled
                  ? `A report appears after ${config?.WINDOW_MINUTES ?? 60} game minutes (about one game hour) of watching.`
                  : "Switch it on and the first health check of the town lands here after one window."
              }
            />
          ) : (
            <>
              <div className="px-5 py-3 border-b border-ui-line">
                <SectionTitle
                  right={
                    trend && (
                      <span className={`text-[10px] ${trend.className}`}>
                        {trend.glyph} {trend.text}
                      </span>
                    )
                  }
                >
                  Last window · day {report.window.day} · {report.window.dayPhase}
                </SectionTitle>
                <div className="grid grid-cols-3 gap-4">
                  <Gauge label="Boredom" value={report.boredScore} goodIsHigh={false} threshold={config?.BOREDOM_THRESHOLD} />
                  <Gauge label="Health" value={report.healthScore} goodIsHigh />
                  <Gauge label="Performance" value={report.perfScore} goodIsHigh />
                </div>
                <div className="mt-2 text-[10px] text-ui-muted">
                  {report.engagement.conversationsStarted} conversations · {report.engagement.dramaEvents} drama ·{" "}
                  {report.engagement.uniqueActionsUsed} kinds of activity · dominant:{" "}
                  <span className="text-ui-dim">
                    {pretty(report.engagement.dominantAction)} ({Math.round(report.engagement.dominantActionRatio * 100)}%)
                  </span>
                </div>
              </div>

              <div className="px-5 py-3 border-b border-ui-line">
                <SectionTitle>What it noticed</SectionTitle>
                {diagnoses.length === 0 ? (
                  <EmptyState compact icon="🌿" title="Nothing wrong with this window." />
                ) : (
                  <ul className="space-y-1.5">
                    {diagnoses.map((d, i) => (
                      <li key={`${d.type}-${i}`} className="text-[11px]">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[9px] px-1 py-px border uppercase tracking-wide shrink-0 ${
                              SEVERITY_STYLE[d.severity] ?? SEVERITY_STYLE.low
                            }`}
                          >
                            {d.severity}
                          </span>
                          <span className="text-ui-text capitalize">{pretty(d.type)}</span>
                          {d.autoFixable && (
                            <span className="text-[9px] text-ui-gold ml-auto shrink-0" title="Autoplay can fix this with a nudge">
                              ✦ fixable
                            </span>
                          )}
                        </div>
                        <p className="text-ui-dim leading-snug mt-0.5 pl-0.5">{d.evidence}</p>
                        <p className="text-ui-muted leading-snug pl-0.5">→ {d.suggestion}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {/* Agents flagged by the latest diagnoses */}
          {report && (
            <div className="px-5 py-3 border-b border-ui-line">
              <SectionTitle>Residents it's worried about</SectionTitle>
              {flagged.length === 0 ? (
                <EmptyState compact icon="🙂" title="Nobody is flagged right now." />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {flagged.map((p) => (
                    <span
                      key={p.agentId}
                      className="text-[10px] px-1.5 py-0.5 bg-ui-raised border border-ui-line text-ui-text"
                      title={p.issues.map(pretty).join(", ")}
                    >
                      {p.name}
                      <span className="text-ui-muted"> · {pretty(p.issues[0])}{p.issueCount > 1 ? ` +${p.issueCount - 1}` : ""}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Auto-nudge log */}
          <div className="px-5 py-3">
            <SectionTitle>Recent auto-nudges</SectionTitle>
            {nudges.length === 0 ? (
              <EmptyState
                compact
                icon="👆"
                title="No automatic nudges yet."
                hint="When boredom stays above the threshold, autoplay's pokes are listed here."
              />
            ) : (
              <ul className="space-y-1">
                {nudges.map((n, i) => (
                  <li key={`${n.timestamp}-${i}`} className="text-[11px] flex gap-2 border-l-2 border-ui-line-accent pl-2">
                    <span className="text-ui-muted shrink-0 w-14">d{n.day} · {String(n.hour).padStart(2, "0")}h</span>
                    <span className="text-ui-text capitalize shrink-0">{pretty(n.type)}</span>
                    <span className="text-ui-dim flex-1 truncate" title={n.reason}>
                      {n.reason}
                    </span>
                    <span className="text-ui-muted shrink-0">{ago(n.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
