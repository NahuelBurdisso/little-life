import { simEvents } from './simEvents';

// ─── Hobby System ─────────────────────────────────────────────────────────────
// Agents develop skills through repeated zone activities.
// Skill levels affect output quality and need satisfaction.
// Shared hobbies boost friendship when agents are co-located.

export type HobbyId = 'fishing' | 'cooking' | 'gardening' | 'performing' | 'foraging' | 'jogging';

interface HobbySkill {
  level: number;        // 0-100
  experience: number;   // raw XP
  lastPracticed: number; // tick
}

// Maps zone activity to hobby
const ACTIVITY_TO_HOBBY: Record<string, HobbyId> = {
  fish: 'fishing',
  cook: 'cooking',
  garden: 'gardening',
  perform: 'performing',
  forage: 'foraging',
  jog: 'jogging',
};

// XP needed per level (diminishing returns)
function xpForLevel(level: number): number {
  return Math.floor(10 + level * level * 0.5);
}

// ─── In-memory skill store ────────────────────────────────────────────────────

const agentHobbies = new Map<number, Map<HobbyId, HobbySkill>>();

function getSkills(agentId: number): Map<HobbyId, HobbySkill> {
  let skills = agentHobbies.get(agentId);
  if (!skills) {
    skills = new Map();
    agentHobbies.set(agentId, skills);
  }
  return skills;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Record that an agent performed a zone activity. Returns new skill level. */
export function practiceHobby(agentId: number, zoneActivity: string, currentTick: number): number {
  const hobbyId = ACTIVITY_TO_HOBBY[zoneActivity];
  if (!hobbyId) return 0;

  const skills = getSkills(agentId);
  let skill = skills.get(hobbyId);
  if (!skill) {
    skill = { level: 0, experience: 0, lastPracticed: 0 };
    skills.set(hobbyId, skill);
  }

  // Grant XP (1 base + bonus for consistent practice)
  const ticksSinceLast = currentTick - skill.lastPracticed;
  const consistencyBonus = ticksSinceLast < 1440 ? 0.5 : 0; // bonus if practiced within 1 game day
  skill.experience += 1 + consistencyBonus;
  skill.lastPracticed = currentTick;

  // Level up check
  const needed = xpForLevel(skill.level);
  if (skill.experience >= needed && skill.level < 100) {
    skill.experience -= needed;
    skill.level++;
    simEvents.emit('hobby:levelup', { agentId, hobby: hobbyId, level: skill.level });
  }

  return skill.level;
}

/** Get skill level for a hobby. Returns 0 if never practiced. */
export function getHobbyLevel(agentId: number, zoneActivity: string): number {
  const hobbyId = ACTIVITY_TO_HOBBY[zoneActivity];
  if (!hobbyId) return 0;
  return getSkills(agentId).get(hobbyId)?.level ?? 0;
}

/** Get all hobbies for an agent with level > 0. */
export function getAgentHobbies(agentId: number): Array<{ hobby: HobbyId; level: number }> {
  const skills = agentHobbies.get(agentId);
  if (!skills) return [];
  const result: Array<{ hobby: HobbyId; level: number }> = [];
  for (const [hobby, skill] of skills) {
    if (skill.level > 0) {
      result.push({ hobby, level: skill.level });
    }
  }
  return result.sort((a, b) => b.level - a.level);
}

/** Output quality multiplier based on skill level. Level 0 = 1.0x, Level 50 = 2.0x, Level 100 = 3.0x */
export function getSkillOutputMultiplier(agentId: number, zoneActivity: string): number {
  const level = getHobbyLevel(agentId, zoneActivity);
  return 1.0 + level * 0.02;
}

/** Need satisfaction bonus from skill. Higher skill = better restoration. */
export function getSkillNeedBonus(agentId: number, zoneActivity: string): number {
  const level = getHobbyLevel(agentId, zoneActivity);
  return level * 0.03; // up to 3.0 extra need points at level 100
}

/** Check if agent A can mentor agent B in any hobby. Returns the hobby or null. */
export function getMentorshipOpportunity(mentorId: number, menteeId: number): HobbyId | null {
  const mentorSkills = agentHobbies.get(mentorId);
  const menteeSkills = agentHobbies.get(menteeId);
  if (!mentorSkills) return null;

  for (const [hobby, mentorSkill] of mentorSkills) {
    if (mentorSkill.level < 10) continue; // need level 10+ to mentor
    const menteeSkill = menteeSkills?.get(hobby);
    const menteeLevel = menteeSkill?.level ?? 0;
    if (menteeLevel < mentorSkill.level - 5) { // at least 5 levels gap
      return hobby;
    }
  }
  return null;
}

/** Apply mentorship bonus: mentee gets 2x XP, mentor gets social satisfaction. */
export function applyMentorship(_mentorId: number, menteeId: number, hobby: HobbyId, currentTick: number): void {
  const menteeSkills = getSkills(menteeId);
  let skill = menteeSkills.get(hobby);
  if (!skill) {
    skill = { level: 0, experience: 0, lastPracticed: 0 };
    menteeSkills.set(hobby, skill);
  }
  // Mentee gets bonus XP
  skill.experience += 2;
  skill.lastPracticed = currentTick;

  const needed = xpForLevel(skill.level);
  if (skill.experience >= needed && skill.level < 100) {
    skill.experience -= needed;
    skill.level++;
    simEvents.emit('hobby:levelup', { agentId: menteeId, hobby, level: skill.level });
  }
}

/** Check if two agents share a hobby. Returns shared hobby names. */
export function getSharedHobbies(agentA: number, agentB: number): HobbyId[] {
  const skillsA = agentHobbies.get(agentA);
  const skillsB = agentHobbies.get(agentB);
  if (!skillsA || !skillsB) return [];

  const shared: HobbyId[] = [];
  for (const [hobby, skillA] of skillsA) {
    const skillB = skillsB.get(hobby);
    if (skillA.level >= 3 && skillB && skillB.level >= 3) {
      shared.push(hobby);
    }
  }
  return shared;
}
