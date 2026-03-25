export type AgentAction =
  | { type: "idle" }
  | { type: "walking"; to: { x: number; y: number } }
  | { type: "talking"; conversationId: string }
  | { type: "working"; taskDescription: string }
  | { type: "eating"; locationId: string }
  | { type: "sleeping" }
  | { type: "shopping"; shopId: string; items: string[] }
  | { type: "socializing"; locationId: string };

export type JobType =
  | "farmer"
  | "farmhand"
  | "shopkeeper"
  | "shop_assistant"
  | "bartender"
  | "doctor"
  | "medical_assistant"
  | "mayor"
  | "handyperson"
  | "musician"
  | "baker"
  | "retired"
  | "unemployed";

export type Season = "spring" | "summer" | "autumn" | "winter";
export type DayPhase = "dawn" | "morning" | "afternoon" | "evening" | "night";
export type WeatherType = "sunny" | "cloudy" | "rainy" | "stormy" | "foggy";
export type WorldEventType =
  | "festival"
  | "market_day"
  | "storm"
  | "new_arrival"
  | "sickness"
  | "harvest";

export type RelationshipStatus =
  | "strangers"
  | "acquaintances"
  | "friends"
  | "close_friends"
  | "best_friends"
  | "rivals"
  | "enemies"
  | "romantic_interest"
  | "partners"
  | "complicated";

export type RelationshipEventType =
  | "conversation"
  | "deep_talk"
  | "argument"
  | "help"
  | "gift"
  | "betrayal"
  | "compliment"
  | "insult"
  | "shared_meal"
  | "shared_activity";

export type TemplateCategory =
  | "greeting_friendly"
  | "greeting_neutral"
  | "greeting_cold"
  | "farewell"
  | "small_talk_weather"
  | "small_talk_work"
  | "purchase"
  | "work_handoff"
  | "complaint_mood"
  | "excited_event"
  | "tired"
  | "hungry";

export type MemoryType =
  | "conversation"
  | "observation"
  | "experience"
  | "emotional"
  | "plan"
  | "opinion";

export type ClockTransition =
  | { type: "hour_changed"; hour: number }
  | { type: "day_changed"; day: number }
  | { type: "phase_changed"; from: DayPhase; to: DayPhase }
  | { type: "season_changed"; from: Season; to: Season };

export type ConversationTier =
  | "llm_deep"
  | "llm_standard"
  | "template"
  | "emote"
  | "skip";

export type LocationType =
  | "home"
  | "shop"
  | "tavern"
  | "farm"
  | "clinic"
  | "town_square"
  | "town_hall"
  | "park";
