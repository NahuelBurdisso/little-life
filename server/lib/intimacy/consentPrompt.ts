import { firstName } from '../../ai/names';

// ─── The consent question, as the model sees it ──────────────────────────────
//
// Pure (no DB): the prompt and its tolerant parser live apart from rendezvous.ts so
// `scripts/llm-smoke.ts` can send the real prompt to a model without opening a
// database, and so a prompt edit is a prompt-only change.

/** LLM consent reads only the tail of the conversation: the answer is in the last lines. */
export const CONSENT_LINES = 4;

export interface ConsentLine {
  speakerId: number;
  speaker: string;
  text: string;
}

export interface ConsentInput {
  /** The transcript, oldest first. */
  lines: readonly ConsentLine[];
  initiatorName: string;
  answererId: number;
  answererName: string;
  /** `willingness` of the one who was asked. */
  willingness: number;
}

export function buildConsentPrompt(input: ConsentInput): { system: string; user: string; format: Record<string, unknown> } {
  const transcript = input.lines.slice(-CONSENT_LINES)
    .map((l) => `${firstName(l.speaker)}: ${l.text}`).join('\n');
  const asker = firstName(input.initiatorName);
  const answerer = firstName(input.answererName);
  const system = `You read the end of a short conversation in a small town around 1900. ${asker} has asked ${answerer} to spend the evening together somewhere private.

${transcript}

Decide whether ${answerer} accepted the invitation. A clear yes, or a warm and willing reply, is accepted. A no, a refusal, a deflection, an excuse or real hesitation is not. Judge only ${answerer}'s own words.

Reply with JSON: {"accepted": true or false, "reason": "a few words"}`;
  return {
    system,
    user: `Did ${answerer} accept?`,
    format: {
      type: 'object',
      properties: { accepted: { type: 'boolean' }, reason: { type: 'string', maxLength: 120 } },
      required: ['accepted', 'reason'],
    },
  };
}

/** `{accepted, reason}` from whatever the model returned, or null when it is unusable. Tolerant of prose around the JSON and of "yes"/"true" strings. */
export function parseConsent(raw: string): { accepted: boolean; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  let accepted: boolean | null = null;
  if (typeof d.accepted === 'boolean') accepted = d.accepted;
  else if (typeof d.accepted === 'string') {
    const v = d.accepted.trim().toLowerCase();
    if (v === 'true' || v === 'yes') accepted = true;
    else if (v === 'false' || v === 'no') accepted = false;
  }
  if (accepted === null) return null;
  const reason = typeof d.reason === 'string' ? d.reason.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return { accepted, reason };
}
