export interface ActivityDef {
  category: string;
  base_importance: number;
  retention: 'short' | 'medium' | 'long' | 'permanent';
  template: string;
  /**
   * false keeps the row out of the Town Crier (lib/gazette.ts) whatever its
   * importance. For rows that must be loud in the UI (alerts, the inbox) but
   * would give the game away in the paper: the player's own hand.
   */
  newsworthy?: boolean;
}

export const ACTIVITY_REGISTRY: Record<string, ActivityDef> = {
  state_gained: { category: 'state', base_importance: 0.3, retention: 'short', template: '{agent} is now {state}' },
  state_lost: { category: 'state', base_importance: 0.2, retention: 'short', template: '{agent} is no longer {state}' },
  conversation_ended: { category: 'social', base_importance: 0.2, retention: 'short', template: '{agent1} and {agent2} finished talking at {location}' },
  salary_paid: { category: 'economy', base_importance: 0.1, retention: 'short', template: '{agent} received {amount} coins as salary' },
  purchase: { category: 'economy', base_importance: 0.15, retention: 'short', template: '{agent} bought {item} for {amount} coins' },
  relationship_status_change: { category: 'relationship', base_importance: 0.7, retention: 'long', template: '{agent1} and {agent2} are now {status}' },
  drama: { category: 'drama', base_importance: 0.8, retention: 'long', template: '{description}' },
  world_event: { category: 'world_event', base_importance: 0.9, retention: 'permanent', template: '{description}' },
  // A whole winter without a death (the challenges' season watch). Town news,
  // and the row the client's "Survived a winter" achievement unlocks on.
  season_survived: { category: 'world_event', base_importance: 0.8, retention: 'long', template: '{description}' },
  system: { category: 'system', base_importance: 0.1, retention: 'short', template: '{message}' },
  error: { category: 'error', base_importance: 0.5, retention: 'medium', template: 'Error in {system}: {message}' },
  interaction_resolved: { category: 'interaction', base_importance: 0.6, retention: 'medium', template: '{initiator_name} {verb} {target_name} at {location}' },
  goal_completed: { category: 'goal', base_importance: 0.6, retention: 'medium', template: '{agent} accomplished their goal: {goal_description}' },
  goal_abandoned: { category: 'goal', base_importance: 0.3, retention: 'short', template: '{agent} gave up on {goal}' },
  goal_created: { category: 'goal', base_importance: 0.4, retention: 'short', template: '{name} set a new goal: {goal}' },
  goal_ambition_shifted: { category: 'aspiration', base_importance: 0.8, retention: 'long', template: '{name} had a change of heart — now driven by {to}' },
  goal_ambition_generated: { category: 'aspiration', base_importance: 0.7, retention: 'long', template: '{name} discovered their life ambition: {ambition}' },
  aspiration_shifted: { category: 'aspiration', base_importance: 0.8, retention: 'long', template: '{agent} had a change of heart — now driven by {aspiration}' },
  player_nudge: { category: 'player', base_importance: 0.4, retention: 'medium', template: '{description}' },
  player_event: { category: 'player', base_importance: 0.5, retention: 'medium', template: '{description}' },
  player_gift: { category: 'player', base_importance: 0.4, retention: 'medium', template: '{description}' },
  player_introduce: { category: 'player', base_importance: 0.6, retention: 'long', template: '{description}' },
  player_remove: { category: 'player', base_importance: 0.6, retention: 'long', template: '{description}' },
  // God powers that plant something (lib/godPowers.ts). Kept below the Town
  // Crier's 0.45 news cut (lib/gazette.ts): "You planted a rumor…" in the
  // paper would give away the hand behind the story. The consequences (the
  // rumor spreading, the jealous scene) make the paper on their own.
  player_whisper: { category: 'player', base_importance: 0.4, retention: 'medium', template: '{description}' },
  player_rumor: { category: 'player', base_importance: 0.4, retention: 'medium', template: '{description}' },
  player_stir: { category: 'player', base_importance: 0.4, retention: 'medium', template: '{description}' },
  // What a nudge / confrontation / revealed secret / planted rumor came to, and
  // nudges that never happened (lib/playerOutcomes.ts). Importance ≥ 0.8 so they
  // alert like drama does — the player asked for this scene and should hear how
  // it ended — but `newsworthy: false`: the paper reports the feud, never
  // "your confrontation". Gazette's importance cut alone can't hold these out.
  player_outcome: { category: 'player', base_importance: 0.85, retention: 'medium', template: '{description}', newsworthy: false },
  player_nudge_expired: { category: 'player', base_importance: 0.8, retention: 'short', template: '{description}', newsworthy: false },
  // The player's optional challenges settling (lib/challenges/evaluate.ts).
  // `player` category and tier: a goal the player set themselves is always
  // worth a toast and an inbox line. Never news — the paper reports the
  // wedding, not "your Matchmaker challenge".
  challenge_completed: { category: 'player', base_importance: 0.9, retention: 'long', template: '{description}', newsworthy: false },
  challenge_failed: { category: 'player', base_importance: 0.8, retention: 'medium', template: '{description}', newsworthy: false },
  plan_generated: { category: 'planning', base_importance: 0.3, retention: 'short', template: '{agentName} planned their day: {summary}' },
  // Reason in parentheses: it may end in "…" (shortenForFeed), and "{reason}." rendered "…." there.
  plan_changed: { category: 'planning', base_importance: 0.5, retention: 'medium', template: '{agentName} changed plans ({reason}). Now: {summary}' },

  // The small ups and downs of a day (lib/dailyLife.ts): a burnt loaf, a soaking, a coin in
  // the street. Low importance: texture for the feed and the resident's panel, not news.
  daily_moment: { category: 'state', base_importance: 0.25, retention: 'short', template: '{description}', newsworthy: false },

  // Something that happened to one resident on a day the story passed them by
  // (lib/personalEvents.ts): a letter from home, a keepsake, a resolution. Their own beat.
  personal_event: { category: 'social', base_importance: 0.6, retention: 'medium', template: '{description}' },

  // ─── Zone Actions ───────────────────────────────────────────────────────────
  cook:        { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} cooked a meal' },
  rest:        { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} rested' },
  contemplate: { category: 'state', base_importance: 0.2, retention: 'short', template: '{agent} sat by the river, lost in thought' },
  fish:        { category: 'state', base_importance: 0.2, retention: 'short', template: '{agent} went fishing' },
  garden:      { category: 'state', base_importance: 0.2, retention: 'short', template: '{agent} tended the garden' },
  forage:      { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} foraged for food' },
  perform:     { category: 'social', base_importance: 0.4, retention: 'medium', template: '{agent} performed for the crowd' },
  watch:       { category: 'social', base_importance: 0.1, retention: 'short', template: '{agent} watched a performance' },
  browse:      { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} browsed the shelves' },
  jog:         { category: 'state', base_importance: 0.1, retention: 'short', template: '{agent} went for a jog' },

  // ─── Crime ──────────────────────────────────────────────────────────────────
  shoplifting: { category: 'drama', base_importance: 0.6, retention: 'medium', template: '{description}' },
  pickpocket:  { category: 'drama', base_importance: 0.7, retention: 'medium', template: '{description}' },

  // ─── Social Events ─────────────────────────────────────────────────────────
  gift:            { category: 'social', base_importance: 0.5, retention: 'medium', template: '{description}' },
  secret_shared:   { category: 'social', base_importance: 0.6, retention: 'long', template: '{description}' },
  confrontation:   { category: 'drama', base_importance: 0.8, retention: 'long', template: '{description}' },
  birthday:        { category: 'social', base_importance: 0.7, retention: 'long', template: '{description}' },
  tavern_tipsy:    { category: 'social', base_importance: 0.3, retention: 'short', template: '{description}' },
  tavern_drunk:    { category: 'drama', base_importance: 0.5, retention: 'medium', template: '{description}' },
  hobby_levelup:   { category: 'social', base_importance: 0.4, retention: 'medium', template: '{agent} improved at {hobby} (level {level})' },

  // ─── Life milestones (lib/milestonesEngine.ts) ──────────────────────────────
  // Their own types rather than `drama` rows: the client's story beats key on
  // the type (hearts for an engagement or a wedding, a broken heart for a
  // refusal) instead of on the wording, and all sit well above the Town
  // Crier's 0.45 news cut — a wedding is exactly what a small-town paper runs.
  proposal:   { category: 'relationship', base_importance: 0.6, retention: 'long', template: '{description}' },
  engagement: { category: 'relationship', base_importance: 0.9, retention: 'permanent', template: '{description}' },
  rejection:  { category: 'drama', base_importance: 0.85, retention: 'long', template: '{description}' },
  wedding:    { category: 'relationship', base_importance: 1.0, retention: 'permanent', template: '{description}' },
  engagement_ended: { category: 'drama', base_importance: 0.7, retention: 'long', template: '{description}' },
  // Newlyweds sharing a house (lib/residents.ts rehomeCouple, at the wedding).
  moved_in:   { category: 'relationship', base_importance: 0.6, retention: 'long', template: '{description}' },
  // Family life (lib/family.ts). The birth itself is a `drama` row tagged
  // `beat: 'birth'` (the canvas and the sound key on the beat); these are the
  // quieter lines around it — the news that a baby is on the way, and the
  // christening on the square a day after the birth.
  expecting:   { category: 'relationship', base_importance: 0.7, retention: 'long', template: '{description}' },
  christening: { category: 'relationship', base_importance: 0.6, retention: 'long', template: '{description}' },

  // ─── Kisses (lib/intimacy/kiss.ts) ─────────────────────────────────────────
  // Their own types rather than `drama` rows (drama is base 0.8, gazette-worthy):
  // a first kiss is a small-town headline, a routine one is texture for the feed
  // that expires quickly, a refusal is a private embarrassment the paper leaves
  // alone. Each row still carries `metadata.beat` for the canvas and the sound.
  first_kiss:    { category: 'relationship', base_importance: 0.65, retention: 'long', template: '{agent1} and {agent2} shared a first kiss' },
  kiss:          { category: 'relationship', base_importance: 0.3, retention: 'short', template: '{agent1} and {agent2} kissed', newsworthy: false },
  kiss_rebuffed: { category: 'drama', base_importance: 0.5, retention: 'medium', template: "{agent2} turned away from {agent1}'s kiss", newsworthy: false },

  // ─── The town calendar (lib/townCalendar.ts) ────────────────────────────────
  // "The Harvest Festival is in two days": town news the feed should carry, but
  // not the paper's material — the gazette gets its own "Coming up" section from
  // the calendar itself, so the notice would only print the same thing twice.
  calendar_notice:   { category: 'world_event', base_importance: 0.5, retention: 'medium', template: '{description}', newsworthy: false },
  // Who is standing for mayor, and the count. Their own types so the client can
  // tell the election's rows apart (sound, Journal) without reading the words.
  election_campaign: { category: 'world_event', base_importance: 0.8, retention: 'long', template: '{description}' },
  election_result:   { category: 'world_event', base_importance: 0.95, retention: 'permanent', template: '{description}' },
};
