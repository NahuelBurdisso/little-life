import { useSyncExternalStore } from 'react';

/**
 * App-wide toasts: the acknowledgement for anything the player does. Before this the
 * app had none, so a failed nudge ("X is sleeping") or a queued one looked exactly like
 * a success. Module-level store so hooks and plain functions can push without context.
 */
export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional leading glyph (emoji or short text). */
  icon?: string;
}

const MAX_TOASTS = 4;
const TTL_MS: Record<ToastTone, number> = { success: 2600, info: 3200, warning: 4200, error: 5200 };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(next: Toast[]) {
  toasts = next;
  for (const l of listeners) l();
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (toasts.some((x) => x.id === id)) publish(toasts.filter((x) => x.id !== id));
}

/** Show a toast; returns its id. The oldest is dropped past `MAX_TOASTS`. */
export function pushToast(message: string, tone: ToastTone = 'info', icon?: string): number {
  const id = nextId++;
  const next = [...toasts, { id, tone, message, icon }];
  while (next.length > MAX_TOASTS) {
    const dropped = next.shift()!;
    const t = timers.get(dropped.id);
    if (t) clearTimeout(t);
    timers.delete(dropped.id);
  }
  publish(next);
  timers.set(id, setTimeout(() => dismissToast(id), TTL_MS[tone]));
  return id;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}
