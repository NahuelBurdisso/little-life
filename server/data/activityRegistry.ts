export interface ActivityDef {
  category: string;
  base_importance: number;
  retention: 'short' | 'medium' | 'long' | 'permanent';
  template: string;
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
  plan_generated: { category: 'planning', base_importance: 0.3, retention: 'short', template: '{agentName} planned their day: {summary}' },
  // Reason in parentheses: it may end in "…" (shortenForFeed), and "{reason}." rendered "…." there.
  plan_changed: { category: 'planning', base_importance: 0.5, retention: 'medium', template: '{agentName} changed plans ({reason}). Now: {summary}' },

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
};
