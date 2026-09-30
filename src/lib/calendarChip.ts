import {
  ANNOUNCE_DAYS_AHEAD, ELECTION, calendarOn, nextHighlight, whenPhrase, type CalendarEntry,
} from "../../server/data/calendar";
import { WORLD_EVENTS } from "../../server/data/worldEventCatalog";

/**
 * The TopBar's "what's coming" chip: "🎃 Harvest Festival in 2 days".
 *
 * Computed from the clock alone (server/data/calendar.ts is pure and the dates
 * are fixed), so it needs no query and can't go stale. It looks as far ahead
 * as the town's own notices (two days), and says "on now" while the day's
 * event runs so the player knows why everyone is on the square. Markets only
 * show when nothing bigger is near: one comes every week.
 */
export interface CalendarChip {
  icon: string;
  /** "Harvest Festival in 2 days" — the full label (wide windows, tooltip). */
  label: string;
  /** For the `title` tooltip. */
  title: string;
}

function eventName(e: CalendarEntry): string {
  return e.kind === "election" ? "Election" : e.name;
}

export function calendarChip(day: number, hour: number): CalendarChip | null {
  // Today's big entry first, while it hasn't finished (the count is read out at resultHour).
  const today = calendarOn(day).filter((e) => e.kind === "festival" || e.kind === "election");
  for (const e of today) {
    const endHour = e.kind === "election" || !e.eventType
      ? ELECTION.resultHour + 1
      : e.startHour + WORLD_EVENTS[e.eventType].durationHours;
    if (hour >= endHour) continue;
    const on = hour >= e.startHour;
    const label = on ? `${eventName(e)} — on now` : `${eventName(e)} today at ${e.startHour}:00`;
    return { icon: e.icon, label, title: on ? `${e.name} is on now` : `${e.name} today at ${e.startHour}:00` };
  }
  const next = nextHighlight(day + 1, ANNOUNCE_DAYS_AHEAD - 1);
  if (!next) return null;
  const inDays = next.entry.day - day;
  const label = `${eventName(next.entry)} ${whenPhrase(inDays)}`;
  return { icon: next.entry.icon, label, title: `${next.entry.name} ${whenPhrase(inDays)} (day ${next.entry.day})` };
}

/**
 * The Journal timeline's day header tags: "🎃 Harvest Festival", "🗳 Election",
 * "🧺 Market Day" — what that day was on the calendar, so a day of drama reads
 * against the fair it happened at. Campaign days are left out (the election
 * day carries it).
 */
export function calendarDayTags(day: number): Array<{ icon: string; name: string }> {
  return calendarOn(day)
    .filter((e) => e.kind !== "campaign")
    .map((e) => ({ icon: e.icon, name: eventName(e) }));
}
