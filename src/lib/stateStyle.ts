/**
 * How each agent state looks on the client, in one place.
 *
 * The look of a state used to be copied into six tables (the canvas ring, the relationship-graph
 * ring, the dashboard chips, the bubble emotes, the inner-monologue badges, the portrait
 * expression) and they drifted: `envious` had no styling anywhere, the adult-layer aftermath
 * states were missing from most, and the badge table still keyed on `in_love`, `injured` and
 * `enraged`, which the simulation never produces. Every consumer now reads this table, and
 * `stateStyle.test.ts` fails when a state is added to `server/data/stateTypes.ts` without either
 * a ring here or an entry in `UNSTYLED`.
 *
 * Pure data (no PixiJS, no DOM) so both the canvas and the React panels can import it.
 */
import type { StateType } from '../../server/data/stateTypes';
import type { EmoteName } from '../components/canvas/emoteFrames';
import type { PortraitMood } from '../components/ui/portraitMood';

export interface StateStyle {
  /** Plain-words name for chips and badges. */
  label: string;
  /** Colour of the ring under the feet (canvas) and round the graph node. Absent = no ring. */
  ring?: number;
  /** The same colour as `#rrggbb`, derived from `ring`, for DOM and 2D-canvas callers. */
  css?: string;
  /** Tailwind classes for the state badge in the inner-monologue panel. */
  chip?: string;
  /** Emote that pops over the agent's head when the state begins. */
  emote?: EmoteName;
  /** Expression the portrait wears (`portraitMood.ts` picks the strongest among a resident's states). */
  portrait?: PortraitMood;
}

const hexCss = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** Build an entry, deriving `css` from `ring` so the two can never disagree. */
function style(label: string, ring: number | undefined, rest: Omit<StateStyle, 'label' | 'ring' | 'css'> = {}): StateStyle {
  return ring === undefined ? { label, ...rest } : { label, ring, css: hexCss(ring), ...rest };
}

export const STATE_STYLE: Record<StateType, StateStyle> = {
  angry: style('angry', 0xef4444, {
    emote: 'anger', portrait: 'angry', chip: 'bg-red-900/40 text-red-300 border-red-800/40',
  }),
  jealous: style('jealous', 0xf43f5e, {
    emote: 'fire', portrait: 'angry', chip: 'bg-amber-900/40 text-amber-300 border-amber-800/40',
  }),
  // Jealousy's quieter cousin (wanting what someone else has, not someone's attention). A mustard
  // olive: clear of jealous's rose, and of sick (lime) and drunk (amber), the two rings it sits between.
  envious: style('envious', 0xb5a642, {
    emote: 'envy', portrait: 'angry', chip: 'bg-yellow-900/40 text-yellow-200 border-yellow-700/40',
  }),
  heartbroken: style('heartbroken', 0xfb7185, {
    emote: 'cry', portrait: 'sad', chip: 'bg-rose-900/40 text-rose-300 border-rose-800/40',
  }),
  infatuated: style('infatuated', 0xec4899, {
    emote: 'heart', portrait: 'smitten', chip: 'bg-pink-900/40 text-pink-300 border-pink-800/40',
  }),
  drunk: style('drunk', 0xf59e0b, { emote: 'dizzy' }),
  alcoholic: style('alcoholic', 0xd97706),
  stressed: style('stressed', 0xf97316, { emote: 'sweat' }),
  in_debt: style('in debt', 0xea580c, { emote: 'money' }),
  depressed: style('depressed', 0x6366f1, { emote: 'cry', portrait: 'sad' }),
  lonely: style('lonely', 0x8b5cf6, { emote: 'think' }),
  sick: style('sick', 0xa3e635, {
    emote: 'sick', chip: 'bg-yellow-900/40 text-yellow-300 border-yellow-800/40',
  }),
  hungover: style('hungover', 0x84cc16, { emote: 'dizzy' }),
  euphoric: style('euphoric', 0x10b981, {
    emote: 'sparkle', portrait: 'happy', chip: 'bg-purple-900/40 text-purple-300 border-purple-800/40',
  }),
  confident: style('confident', 0x14b8a6, { emote: 'star' }),
  grieving: style('grieving', 0x6b7280, {
    portrait: 'sad', chip: 'bg-ui-raised/60 text-ui-text border-ui-line/40',
  }),

  // ── The adult layer's aftermath ──────────────────────────────────────────────────────────
  // Discretion is the point of that layer, so nothing here shouts. `afterglow` gets no ring at
  // all: the blush emote and the smitten portrait already say it to whoever is looking closely,
  // and a glowing halo on the map would announce a night together to the whole town. `guilty`
  // and `suspicious` get muted, desaturated rings (dusty mauve, grey teal) that a viewer can
  // read as "something is off with them" without learning what; both sit at the bottom of the
  // priority so any ordinary feeling outranks them.
  afterglow: style('afterglow', undefined, { emote: 'blush', portrait: 'smitten' }),
  guilty: style('guilty', 0x8f7fa8, { emote: 'sweat', portrait: 'sad' }),
  suspicious: style('suspicious', 0x7fa39a, { emote: 'question' }),

  // Arrested keeps no ring (it never had one): the hunched pose and the shocked portrait carry it.
  arrested: style('arrested', undefined, { portrait: 'shocked' }),
};

/**
 * States that deliberately draw no ring. Explicit so that forgetting a new state is a test
 * failure rather than a silent gap. See the comments above for why each one is here.
 */
export const UNSTYLED: ReadonlySet<StateType> = new Set<StateType>(['afterglow', 'arrested']);

/**
 * Which ringed state wins when several are active, highest first. The first fifteen are the
 * order the canvas ring always used; `envious` slots in right after `jealous` (the state it
 * shades into), and the two quiet adult-layer states trail everything else.
 */
export const STATE_PRIORITY: readonly StateType[] = [
  'angry', 'jealous', 'envious', 'heartbroken', 'infatuated',
  'drunk', 'alcoholic', 'stressed', 'in_debt',
  'depressed', 'lonely', 'sick', 'hungover',
  'euphoric', 'confident', 'grieving',
  'guilty', 'suspicious',
];

/** The state whose ring an agent wears, or undefined when none of its states has one. */
export function topState(states: readonly string[]): StateType | undefined {
  for (const s of STATE_PRIORITY) if (states.includes(s)) return s;
  return undefined;
}

/** Entry for a raw state string from the server, guarding against prototype keys. */
export function styleOf(state: string): StateStyle | undefined {
  return Object.prototype.hasOwnProperty.call(STATE_STYLE, state) ? STATE_STYLE[state as StateType] : undefined;
}

/** "in debt" for `in_debt`; unknown states fall back to their id with underscores removed. */
export function stateLabel(state: string): string {
  return styleOf(state)?.label ?? state.replace(/_/g, ' ');
}

/** `#rrggbb` ring colour of a state, or `fallback` for states without a ring. */
export function stateCss(state: string, fallback: string): string {
  return styleOf(state)?.css ?? fallback;
}
