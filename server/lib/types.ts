export type Season = "spring" | "summer" | "autumn" | "winter";
export type DayPhase = "dawn" | "morning" | "afternoon" | "evening" | "night";
export type WeatherType = "sunny" | "cloudy" | "rainy" | "stormy" | "foggy" | "snowy" | "windy" | "hot";

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
  | "complicated"
  | "estranged";

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
