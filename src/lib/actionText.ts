/**
 * Player-facing wording for what an agent is doing right now.
 *
 * `agents.current_action` is `{ type, zoneActivity?, ... }`. `type` is the coarse
 * simulation state (idle / working / eating ...) and `zoneActivity` is the
 * specific thing an idle agent picked at a place (fish, garden, perform ...), so
 * the zone activity wins when present. The old tooltip printed `type` verbatim,
 * which read as "idle" for someone who was actually fishing.
 */

/** Activities that already say where they happen, so the place name is not appended. */
const ZONE_ACTIVITY_TEXT: Record<string, string> = {
  contemplate: "lost in thought",
  fish: "fishing by the river",
  garden: "tending the garden",
  forage: "foraging for herbs",
  perform: "performing for the crowd",
  jog: "out for a jog",
  browse: "browsing the shelves",
  rest: "taking a rest",
  comfort: "looking for comfort",
  cook: "cooking",
  watch: "people-watching",
  people_watch: "people-watching",
  comfort_visit: "looking for comfort",
  arrest: "making an arrest",
  pickpocket: "lurking with sticky fingers",
  shoplifting: "up to no good",
};

/** `place` is null-safe so callers can pass "location unknown" straight through. */
const TYPE_TEXT: Record<string, (place: string | null) => string> = {
  sleeping: (p) => (p ? `sleeping at ${p}` : "sleeping"),
  eating: (p) => (p ? `having a meal at ${p}` : "having a meal"),
  working: (p) => (p ? `working at ${p}` : "working"),
  socializing: (p) => (p ? `chatting at ${p}` : "chatting"),
  talking: () => "in conversation",
  walking: () => "on the move",
  shopping: (p) => (p ? `shopping at ${p}` : "shopping"),
  comfort: () => "looking for comfort",
  drama: () => "caught up in drama",
  arrested: () => "under arrest",
  idle: (p) => (p ? `spending time at ${p}` : "taking a moment"),
};

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "Fishing by the river", "Working at Rosa's Bakery", "Sleeping"...
 * `place` is the name of the building the agent is in, when known.
 */
export function describeAction(action: unknown, place?: string | null): string {
  if (typeof action === "string") return capitalize(humanize(action));
  if (!action || typeof action !== "object") return "Taking a moment";

  const a = action as { type?: unknown; zoneActivity?: unknown; description?: unknown };
  // A description written by the simulation beats anything derived here.
  if (typeof a.description === "string" && a.description.trim()) return capitalize(a.description.trim());

  // `plan:decomposed` and `goal:seek_target` are decision *sources* the utility AI
  // stores in the same field, not activities: fall through to the coarse type.
  const zone = typeof a.zoneActivity === "string" && !a.zoneActivity.includes(":") ? a.zoneActivity : null;
  if (zone) {
    return capitalize(ZONE_ACTIVITY_TEXT[zone] ?? humanize(zone));
  }

  const type = typeof a.type === "string" ? a.type : null;
  if (!type) return "Taking a moment";
  const make = TYPE_TEXT[type];
  return capitalize(make ? make(place ?? null) : humanize(type));
}
