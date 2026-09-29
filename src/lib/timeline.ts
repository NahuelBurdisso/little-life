/**
 * Pure helpers behind the town timeline (components/ui/Timeline.tsx) and a
 * resident's "Story so far" tab. Type-only imports from the server, so nothing
 * of the DB reaches the bundle.
 */

import type { TimelineDay, TimelinePage } from "../../server/lib/timeline";

export type { TimelineDay, TimelinePage };

/**
 * Flatten the pages of the infinite query into one list of days.
 *
 * The server ends every page on a day boundary, so a day normally arrives in
 * one piece — but the page can still be cut inside a day (a day with more rows
 * than the server's completion ceiling, or ids not perfectly in clock order
 * after a speed change), and then the two halves must read as one section
 * rather than two "Day 12" headings.
 */
export function mergeTimelinePages(pages: readonly TimelinePage[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const page of pages) {
    for (const day of page.days) {
      const last = days[days.length - 1];
      if (last && last.day === day.day) {
        days[days.length - 1] = { ...last, headline: last.headline ?? day.headline, events: [...last.events, ...day.events] };
      } else {
        days.push(day);
      }
    }
  }
  return days;
}

interface InvolvedRow {
  agent_ids?: readonly number[];
  initiator_id?: number | null;
  target_id?: number | null;
}

/**
 * The resident a row is "about", for click-to-focus: the first agent the row
 * lists, like the live feed does. `exceptId` skips the resident whose story is
 * already open, so clicking a line in their Story tab jumps to the OTHER
 * person in it (null when there is nobody else).
 */
export function subjectOf(row: InvolvedRow, exceptId?: number): number | null {
  const candidates = [...(row.agent_ids ?? []), row.initiator_id, row.target_id];
  for (const id of candidates) {
    if (id != null && id !== exceptId) return id;
  }
  return null;
}

/** "today" / "yesterday" / "5 days ago" for a section heading. */
export function relativeDay(day: number, nowDay: number): string {
  const ago = nowDay - day;
  if (ago <= 0) return "today";
  if (ago === 1) return "yesterday";
  return `${ago} days ago`;
}

/** Game day of an absolute game minute (what the server buckets by). */
export function dayOfMinute(minute: number): number {
  return Math.floor(minute / 1440);
}
