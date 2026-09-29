/**
 * "Meet the town": one card per resident, assembled on the client from queries
 * the app already makes (agents.getActive, relationships.getGraph,
 * knowledge.getSecretNetwork, chronicle.getArcs, locations.getAll). Pure so the
 * choices - who counts as a tie or a rival, what a secret count may reveal - are
 * testable without React.
 */

export interface TourAgent {
  id: number;
  name: string;
  age: number;
  bio: string;
  portrait_sprite?: string;
  workplace?: number | null;
}

export interface TourRelationship {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  status: string;
}

/** A row of knowledge.getSecretNetwork; only who it is about and whether it is still hidden. */
export interface TourSecret {
  subjectName: string | null;
  isPublic: boolean;
}

export interface TourArc {
  id: string;
  kind: string;
  title: string;
  participants: number[];
}

export interface TourPlace {
  id: number;
  name: string;
}

export interface CardLink {
  id: number;
  name: string;
  /** Human wording of the relationship status ("best friends", "rivals"). */
  label: string;
}

export interface ResidentCard {
  id: number;
  name: string;
  age: number;
  portraitSprite: string | undefined;
  /** Where they work, from their workplace location; null when they have none. */
  workplace: string | null;
  hook: string;
  tie: CardLink | null;
  rival: CardLink | null;
  /** How many still-hidden secrets are about them. The content is never carried. */
  secretCount: number;
  arcs: Array<{ id: string; kind: string; title: string }>;
}

/** A tie has to be at least this warm (average friendship, -100..100) to be worth naming. */
const TIE_MIN_FRIENDSHIP = 20;
const TIE_MIN_ROMANCE = 30;
/** A rival has to be at least this cold. */
const RIVAL_MAX_FRIENDSHIP = -20;
const HOSTILE = new Set(['enemies', 'rivals', 'estranged']);

const STATUS_LABEL: Record<string, string> = {
  partners: 'partners',
  romantic_interest: 'romantic interest',
  complicated: "it's complicated",
  best_friends: 'best friends',
  close_friends: 'close friends',
  friends: 'friends',
  acquaintances: 'acquaintances',
  enemies: 'enemies',
  rivals: 'rivals',
  estranged: 'estranged',
  strangers: 'strangers',
};

export function relationLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

/**
 * The first sentence of a bio, shortened to fit a card. Cut at a word boundary
 * so a card never ends mid-word.
 */
export function bioHook(bio: string, max = 110): string {
  const flat = bio.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^.+?[.!?](?=\s|$)/);
  const first = m ? m[0] : flat;
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** "hides 1 secret" / "hides 3 secrets"; null when there is nothing to tease. */
export function secretsLine(count: number): string | null {
  if (count <= 0) return null;
  return `hides ${count} secret${count === 1 ? '' : 's'}`;
}

function pickLinks(
  agentId: number,
  rels: TourRelationship[],
  nameOf: Map<number, string>,
): { tie: CardLink | null; rival: CardLink | null } {
  type Candidate = CardLink & { score: number; friendship: number };
  let tie: Candidate | null = null;
  let rival: Candidate | null = null;
  for (const r of rels) {
    if (r.agent_a !== agentId && r.agent_b !== agentId) continue;
    const otherId = r.agent_a === agentId ? r.agent_b : r.agent_a;
    const name = nameOf.get(otherId);
    if (name === undefined) continue; // moved away / dead: not part of the town any more
    const friendship = (r.friendship_ab + r.friendship_ba) / 2;
    const romance = Math.max(r.romance_ab, r.romance_ba);
    const link = { id: otherId, name, label: relationLabel(r.status) };

    // Romance counts extra: a partner should beat a merely warm friend.
    const warmth = friendship + Math.max(0, romance) * 0.5;
    if ((friendship >= TIE_MIN_FRIENDSHIP || romance >= TIE_MIN_ROMANCE) && (!tie || warmth > tie.score)) {
      tie = { ...link, score: warmth, friendship };
    }
    const cold = -friendship;
    if ((friendship <= RIVAL_MAX_FRIENDSHIP || HOSTILE.has(r.status)) && (!rival || cold > rival.score)) {
      rival = { ...link, score: cold, friendship };
    }
  }
  // A complicated romance with cold friendship qualifies as both. List the
  // person once, on the side their friendship points to.
  if (tie && rival && tie.id === rival.id) {
    return tie.friendship >= 0 ? { tie: strip(tie), rival: null } : { tie: null, rival: strip(rival) };
  }
  return { tie: tie ? strip(tie) : null, rival: rival ? strip(rival) : null };
}

function strip({ id, name, label }: CardLink): CardLink {
  return { id, name, label };
}

export function buildResidentCards(input: {
  agents: TourAgent[];
  relationships: TourRelationship[];
  secrets: TourSecret[];
  arcs: TourArc[];
  places: TourPlace[];
}): ResidentCard[] {
  const nameOf = new Map(input.agents.map((a) => [a.id, a.name]));
  const placeOf = new Map(input.places.map((p) => [p.id, p.name]));
  const hidden = new Map<string, number>();
  for (const s of input.secrets) {
    if (s.isPublic || !s.subjectName) continue;
    hidden.set(s.subjectName, (hidden.get(s.subjectName) ?? 0) + 1);
  }
  return input.agents.map((a) => {
    const { tie, rival } = pickLinks(a.id, input.relationships, nameOf);
    return {
      id: a.id,
      name: a.name,
      age: a.age,
      portraitSprite: a.portrait_sprite,
      workplace: a.workplace != null ? (placeOf.get(a.workplace) ?? null) : null,
      hook: bioHook(a.bio),
      tie,
      rival,
      secretCount: hidden.get(a.name) ?? 0,
      arcs: input.arcs
        .filter((arc) => arc.participants.includes(a.id))
        .map(({ id, kind, title }) => ({ id, kind, title })),
    };
  });
}
