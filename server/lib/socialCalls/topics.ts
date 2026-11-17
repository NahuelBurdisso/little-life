/**
 * What a social call's conversation is about, in the two places a topic is read:
 *
 *   - the LLM tier: `socialCallIntent` turns the topic into the opener's intent
 *     (ai/prompts.ts `topicIntent`), so the caller says why they came instead of
 *     "You want to talk about a vigil at the bedside";
 *   - the template tier: the call scripts (data/socialCallScripts.ts) key on the
 *     queue entry's trigger, and on these exact phrases where one kind has two
 *     moods (a welcome home or a piece of someone's mind).
 *
 * The topic is also what memories and the conversation row show ("talked about
 * a vigil at the bedside"), so each is a plain noun phrase.
 *
 * Pure: imported by ai/prompts.ts and the script data.
 */

export const CALL_TOPIC = {
  sick_visit: 'a visit to the sickbed',
  vigil: 'a vigil at the bedside',
  condolence: 'condolences for a loss',
  congratulate_engagement: 'congratulations on the engagement',
  congratulate_election: 'congratulations on becoming mayor',
  congratulate_goal: 'congratulations on a hard-won success',
  birthday_wish: 'birthday wishes',
  welcome: 'a welcome to town',
  console_election: 'consolation after losing the election',
  console_heartbreak: 'consolation over a broken heart',
  console_work: 'consolation after losing work',
  plead_to_stay: 'a plea to stay in town',
  welcome_home: 'a welcome home from jail',
  reproach: 'a piece of my mind about jail',
  lend_money: 'an offer of a loan',
} as const;

/** A peacemaker's call (lib/factions/mediate.ts): the topic names the other side of the quarrel. */
export const MEDIATE_TOPIC_PREFIX = 'a word about the quarrel with ';

export function mediateTopic(otherFirst: string): string {
  return `${MEDIATE_TOPIC_PREFIX}${otherFirst}`;
}

/** The trigger_reason a call's conversation is queued with. */
export function callTrigger(kind: string): string {
  return `social_call:${kind}`;
}

/** The call kind behind a trigger_reason, or null for any other conversation. */
export function callKindOfTrigger(trigger: string | null | undefined): string | null {
  const m = /^social_call:([a-z_]+)/.exec(trigger ?? '');
  return m ? m[1] : null;
}

/**
 * The opener's intent for a call topic, or null when the topic is not a call's.
 * Written for the caller (participants[0] opens): they came on purpose, and
 * they say why.
 */
export function socialCallIntent(topic: string, other: string): string | null {
  const t = topic.trim();
  if (t.toLowerCase().startsWith(MEDIATE_TOPIC_PREFIX)) {
    const third = t.slice(MEDIATE_TOPIC_PREFIX.length).trim() || 'someone';
    return `${other} has fallen out with ${third}, and you care about them both. You came to talk ${other} round: hear them out, don't take sides, and say what you think it would take to make peace.`;
  }
  switch (t.toLowerCase()) {
    case CALL_TOPIC.sick_visit:
      return `${other} is ill, and you have walked over to see how they are. Ask after their health, offer what help you can, and don't tire them.`;
    case CALL_TOPIC.vigil:
      return `${other} is gravely ill and may not recover. You have come to sit with them. Be gentle and present; say what matters to you, in the manner of the time.`;
    case CALL_TOPIC.condolence:
      return `${other} has just lost someone dear. You have come to offer your condolences: be quiet and kind, name the one they lost if you can, and offer help.`;
    case CALL_TOPIC.congratulate_engagement:
      return `${other} has just become engaged. You came to congratulate them warmly and ask about the wedding.`;
    case CALL_TOPIC.congratulate_election:
      return `${other} has just been elected mayor. You came to congratulate them, and maybe to say what you hope they'll do.`;
    case CALL_TOPIC.congratulate_goal:
      return `${other} has just achieved something they worked hard for. You came to congratulate them and hear how they did it.`;
    case CALL_TOPIC.birthday_wish:
      return `It is ${other}'s birthday today. You came to wish them a happy birthday.`;
    case CALL_TOPIC.welcome:
      return `${other} has just moved to town and you have come to welcome them: introduce yourself, say something useful about the town, and make them feel at home.`;
    case CALL_TOPIC.console_election:
      return `${other} has just lost the election for mayor. You came to console them — no gloating, no politics.`;
    case CALL_TOPIC.console_heartbreak:
      return `${other}'s heart has just been broken. You came to console them and take their mind off it.`;
    case CALL_TOPIC.console_work:
      return `${other} has just lost their work. You came to console them and to think with them about what comes next.`;
    case CALL_TOPIC.plead_to_stay:
      return `You've heard ${other} is thinking of leaving town for good. You came to ask them to stay: tell them plainly what they mean to you and to the town.`;
    case CALL_TOPIC.welcome_home:
      return `${other} has just been let out of jail. You came to meet them and welcome them home, without judging.`;
    case CALL_TOPIC.reproach:
      return `${other} has just been let out of jail, and you are ashamed of what they did. You came to give them a piece of your mind — stern, not cruel.`;
    case CALL_TOPIC.lend_money:
      return `${other} has fallen on hard times and is short of money. You came to offer a loan, tactfully, so they can pay it back when they are on their feet.`;
    default:
      return null;
  }
}
