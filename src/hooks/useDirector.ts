import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrewing } from './useBrewing';
import type { DramaAlert } from './useDramaAlerts';
import { emitCanvasEvent, onCanvasEvent } from '../lib/canvasBus';
import { renderMessage } from '../lib/activityMessage';
import {
  DIRECTOR,
  INITIAL_DIRECTOR_STATE,
  buildCandidates,
  stepDirector,
  type DirectorAlert,
  type DirectorEvent,
  type DirectorIntervention,
  type DirectorState,
  type Shot,
} from '../lib/director';
import { buildCaption, type Caption } from '../lib/directorCaption';
import type { AgentView, ConversationView, LocationView, WorldEventView } from '../lib/apiTypes';

const CAPTIONS_KEY = 'little-life:director-captions';

/** Captions default to on; a stored "0" is the only thing that turns them off. */
function loadCaptionsOn(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveCaptionsOn(on: boolean): void {
  try {
    localStorage.setItem(CAPTIONS_KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

/** How long a seen alert / nudge stays on the director's books (longer than any freshness window). */
const REMEMBER_MS = 60_000;

interface UseDirectorArgs {
  /** The toolbar's Director switch. */
  enabled: boolean;
  agents: ReadonlyArray<AgentView>;
  conversations: ReadonlyArray<ConversationView>;
  locations: ReadonlyArray<LocationView>;
  events: ReadonlyArray<WorldEventView>;
  alerts: readonly DramaAlert[];
  favorites: ReadonlySet<string>;
  /**
   * Select + lock the camera on a resident. Must be the raw version that does
   * NOT count as player input, or every cut would pause the director.
   */
  followAgent: (agentId: string) => void;
}

/**
 * Runs the spectator director (lib/director.ts) against live data.
 *
 * Every `DIRECTOR.TICK_MS` it scores the town and, when the pure logic says
 * "cut", moves the camera through the same mechanisms the player uses: a
 * resident shot is `followAgent` (selection + follow lock, so the camera trails
 * them while they walk), a place shot is the canvas bus `focusLocation`.
 *
 * It keeps its own books of things that are fleeting in the UI — a toast lives
 * 6-12 s, but an alert stays worth a cut for 30 — and of when this tab first saw
 * each world event (the server only says when it started in game time).
 *
 * Player camera input calls `notePlayerInput`, which pauses the director for
 * `DIRECTOR.PAUSE_MS`; after that it starts a fresh shot, not resumes a stale one.
 */
export function useDirector({ enabled, agents, conversations, locations, events, alerts, favorites, followAgent }: UseDirectorArgs) {
  const { brewing } = useBrewing();

  // Latest inputs for the interval, so it doesn't restart on every render.
  const live = useRef({ agents, conversations, locations, events, alerts, favorites, brewing, followAgent });
  live.current = { agents, conversations, locations, events, alerts, favorites, brewing, followAgent };

  const stateRef = useRef<DirectorState>(INITIAL_DIRECTOR_STATE);
  const [shot, setShot] = useState<Shot | null>(null);

  // Books of fleeting things.
  const seenAlerts = useRef(new Map<number, DirectorAlert>());
  const seenEvents = useRef(new Map<number, number>());
  const interventions = useRef<DirectorIntervention[]>([]);
  const interventionSeq = useRef(0);

  const nameOf = useCallback((id: number): string => {
    const a = live.current.agents.find((x) => Number(x.id) === id);
    return a?.name ?? `Agent ${id}`;
  }, []);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ── pause on player input ───────────────────────────────────────────────────
  const pausedUntilRef = useRef(0);
  const [pausedUntil, setPausedUntil] = useState(0);

  const tick = useCallback(() => {
    const now = Date.now();
    if (!enabledRef.current || now < pausedUntilRef.current) return;
    const cur = live.current;

    for (const a of cur.alerts) {
      if (!seenAlerts.current.has(a.id)) {
        seenAlerts.current.set(a.id, {
          id: a.id,
          tier: a.tier,
          agentIds: (a.agent_ids ?? []).map(Number),
          shownAt: a.shownAt,
          label: renderMessage(a),
        });
      }
    }
    for (const [id, a] of seenAlerts.current) if (now - a.shownAt > REMEMBER_MS) seenAlerts.current.delete(id);

    const liveEventIds = new Set<number>();
    const eventList: DirectorEvent[] = [];
    for (const e of cur.events) {
      liveEventIds.add(e.id);
      if (!seenEvents.current.has(e.id)) seenEvents.current.set(e.id, now);
      eventList.push({ id: e.id, name: e.name, locationId: e.location_id ?? null, firstSeenAt: seenEvents.current.get(e.id)! });
    }
    for (const id of seenEvents.current.keys()) if (!liveEventIds.has(id)) seenEvents.current.delete(id);

    interventions.current = interventions.current.filter((i) => now - i.at < REMEMBER_MS);

    const candidates = buildCandidates({
      now,
      conversations: cur.conversations,
      brewing: cur.brewing,
      alerts: [...seenAlerts.current.values()],
      events: eventList,
      interventions: interventions.current,
      favorites: cur.favorites,
      nameOf,
    });

    const result = stepDirector(stateRef.current, candidates, now, {
      locations: cur.locations,
      agents: cur.agents.map((a) => ({ id: a.id, current_location: a.current_location ?? null, current_action: a.current_action })),
    });
    stateRef.current = result.state;
    const next = result.state.current;
    setShot((prev) => (prev && next && sameShot(prev, next) ? prev : next));

    const cut = result.cut;
    if (!cut) return;
    const lead = cut.agentIds.find((id) => cur.agents.some((a) => Number(a.id) === id));
    if (lead != null) {
      cur.followAgent(String(lead));
    } else if (cut.locationId != null) {
      emitCanvasEvent({ type: 'focusLocation', locationId: cut.locationId });
    }
  }, [nameOf]);

  // The loop: an immediate look when switched on, then every TICK_MS.
  useEffect(() => {
    if (!enabled) {
      stateRef.current = INITIAL_DIRECTOR_STATE;
      setShot(null);
      pausedUntilRef.current = 0;
      setPausedUntil(0);
      return;
    }
    tick();
    const id = window.setInterval(tick, DIRECTOR.TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled, tick]);

  // The player poked someone: that is a scene they want to see play out.
  useEffect(() => onCanvasEvent((e) => {
    if (e.type !== 'intervention' || e.agentIds.length === 0) return;
    const names = e.agentIds.map(nameOf).join(' & ');
    interventions.current.push({ id: ++interventionSeq.current, agentIds: [...e.agentIds], at: Date.now(), label: `Your doing: ${names}` });
  }), [nameOf]);

  const notePlayerInput = useCallback(() => {
    if (!enabledRef.current) return;
    const until = Date.now() + DIRECTOR.PAUSE_MS;
    pausedUntilRef.current = until;
    // Wheel zoom fires this per notch: only touch state when it matters.
    setPausedUntil((prev) => (prev === 0 || until - prev > 1000 ? until : prev));
    // Resume with a clean slate: the old shot's hold clock is meaningless after 20 s.
    stateRef.current = { ...stateRef.current, current: null };
    setShot(null);
  }, []);

  const resume = useCallback(() => {
    pausedUntilRef.current = 0;
    setPausedUntil(0);
    tick();
  }, [tick]);

  useEffect(() => {
    if (!pausedUntil) return;
    const id = window.setTimeout(() => {
      // Input arrived after this timer was set: the ref knows, re-arm for it.
      if (pausedUntilRef.current > Date.now()) {
        setPausedUntil(pausedUntilRef.current);
        return;
      }
      setPausedUntil(0);
      tick();
    }, Math.max(0, pausedUntil - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [pausedUntil, tick]);

  // ── captions ────────────────────────────────────────────────────────────────
  const [captionsOn, setCaptionsOn] = useState(loadCaptionsOn);
  const toggleCaptions = useCallback((): boolean => {
    const next = !captionsOn;
    setCaptionsOn(next);
    saveCaptionsOn(next);
    return next;
  }, [captionsOn]);

  // A conversation leaves the active list the moment it ends; keep its last
  // caption on screen until the camera moves on (the fade-out is the cut).
  const lingering = useRef<{ since: number; caption: Caption } | null>(null);
  let caption: Caption | null = null;
  if (enabled && captionsOn && shot) {
    const built = buildCaption(shot, conversations, nameOf);
    const talking = built != null && built.conversationId != null;
    const lingerHere = lingering.current?.since === shot.since ? lingering.current.caption : null;
    if (built && talking) lingering.current = { since: shot.since, caption: built };
    // Once the talk is over `built` is only the shot's bare label, which would
    // replace the lines that were just on screen: keep the last real caption.
    caption = talking ? built : (lingerHere ?? built);
  }

  return {
    shot: enabled ? shot : null,
    caption,
    /** Identifies one camera cut; the caption fades out when it changes. */
    cut: shot?.since ?? 0,
    paused: enabled && pausedUntil > 0,
    resume,
    notePlayerInput,
    captionsOn,
    toggleCaptions,
  };
}

/** Same cut for display purposes: avoids a re-render for every re-score of the current shot. */
function sameShot(a: Shot, b: Shot): boolean {
  return a.since === b.since && a.key === b.key && a.label === b.label;
}
