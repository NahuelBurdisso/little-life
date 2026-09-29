import type { ConnectionStatus } from './connectionState';

/**
 * What the health banner (components/ui/HealthBanner.tsx) says, as pure rules.
 *
 * One line at a time, most urgent first: a dead socket beats an LLM outage beats
 * a slow LLM beats embeddings beats a lagging clock. Two banners stacked under
 * the top bar would eat the map for something the player can do little about.
 */

/** Shape of `world.getHealth` (server/lib/health.ts), restated so this stays a pure client module. */
export interface HealthLike {
  llm: { status: 'ok' | 'degraded' | 'down'; reason: string | null };
  breakerOpen: boolean;
  embeddings: { ok: boolean; reason: string | null };
  tick: { lastTickOverrunMs: number; slowTicksLastMinute: number; lagging: boolean };
}

export type BannerSeverity = 'critical' | 'warning' | 'notice';

export interface Banner {
  /** Stable per condition; with `text` it identifies what a dismissal applies to. */
  id: 'offline' | 'llm-down' | 'llm-degraded' | 'embeddings' | 'lagging';
  severity: BannerSeverity;
  text: string;
  /** Extra detail for a tooltip, when the line itself stays short. */
  detail?: string;
  /** Critical banners cannot be dismissed: the player must not lose sight of them. */
  dismissible: boolean;
  /** A spinner-ish pulse: we are actively trying to recover. */
  pulse?: boolean;
}

export function pickBanner(input: { connection: ConnectionStatus; health: HealthLike | null | undefined }): Banner | null {
  const { connection, health } = input;

  // Only `closed` counts: `connecting` is every page load's first second.
  if (connection === 'closed') {
    return { id: 'offline', severity: 'critical', text: 'Reconnecting to the town…', dismissible: false, pulse: true };
  }
  if (!health) return null;

  if (health.llm.status === 'down') {
    return {
      id: 'llm-down',
      severity: 'critical',
      text: `LLM offline: ${health.llm.reason ?? 'no answer from the model'}`,
      detail: 'Townsfolk follow their routines and chat from templates until the model answers again.',
      dismissible: false,
    };
  }
  if (health.llm.status === 'degraded') {
    return {
      id: 'llm-degraded',
      severity: 'warning',
      text: 'The townsfolk are thinking slowly (LLM degraded) — conversations use simple lines',
      detail: health.llm.reason ?? undefined,
      dismissible: true,
    };
  }
  if (!health.embeddings.ok) {
    return {
      id: 'embeddings',
      severity: 'notice',
      text: `Memory search is offline: ${health.embeddings.reason ?? 'embedding model not answering'}`,
      detail: 'Townsfolk still remember, but recall by meaning is off until embeddings answer again.',
      dismissible: true,
    };
  }
  if (health.tick.lagging) {
    const secs = (health.tick.lastTickOverrunMs / 1000).toFixed(1);
    return {
      id: 'lagging',
      severity: 'notice',
      text: `The town is running behind — ticks are taking ${secs}s, so the clock runs slower than asked`,
      detail: `${health.tick.slowTicksLastMinute} slow ticks in the last minute. Try a lower speed.`,
      dismissible: true,
    };
  }
  return null;
}

/**
 * What a dismissal is remembered against: the condition plus its cause, so a
 * different reason is new information and shows again. The lag banner is keyed
 * by id alone: its text carries a number that changes every few seconds, and a
 * dismissal that re-armed with every jitter would make the banner undismissable.
 */
export function bannerKey(b: Banner | null): string | null {
  if (!b) return null;
  return b.id === 'lagging' ? b.id : `${b.id}:${b.text}`;
}
