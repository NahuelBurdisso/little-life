/**
 * The fire brigade: the showcase of the town acting together.
 *
 * The `fire_outbreak` world event said "Townspeople rush to help contain the
 * blaze" and nobody moved; it burned no building in particular (the canvas
 * picked a roof by hash). Now the event burns a real building (the venue
 * resolver below, registered on startWorldEvent), and it is an urgent gathering:
 *
 *   must   — whoever owns the place, and whoever lives in it;
 *   should — anyone awake within sight of the smoke, and the brave, dutiful or
 *            warm anywhere in town; sleepers within earshot are woken (the one
 *            kind allowed to wake people) and come too. A fire pulls people off a
 *            work shift;
 *   may    — the cowardly and the cold, and the rest of the town: they watch from
 *            across the street, or stay away.
 *
 * Fifty minutes in, the turnout decides it. Enough hands and it is put out: the
 * owner is grateful (a favour owed to every helper, friendship, reputation for
 * the helpers), the event ends. Too few and the place burns: the owner loses
 * money (to the treasury, as repairs — never out of the economy) and stock, and
 * holds it against the close friends who never came.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, economy, locations, needs } from '../../../db/schema';
import { firstName } from '../../../ai/names';
import { setEventVenueResolver } from '../../../engine/systems/events';
import { payTreasury } from '../../economyTransfers';
import { removeFromInventory } from '../../economyEngine';
import { recordFavorGiven } from '../../favorEngine';
import { adjustReputation } from '../../reputationEngine';
import { getEffectivePersonality } from '../../states';
import type { PersonalityProfile } from '../../personality';
import { gatherCandidates } from '../../socialCalls/ties';
import { feel, mood, remember } from '../../socialCalls/effects';
import { noteOrdeal } from '../../socialCalls/reciprocity';
import { invite, scheduleGathering } from '../engine';
import {
  DAY, HOUR, endWrappedEvent, excused, gatheringFeed, isActive, nameList, rngFor, statesOf,
} from '../common';
import { GATHERING_TOPIC } from '../topics';
import type { Gathering, GatheringKind } from '../types';
import { FRIENDS, KIN, holds } from './invites';

/** Building types that can burn (the canvas draws flames on the same set: eventDecor.ts BURNABLE). */
export const BURNABLE: ReadonlySet<string> = new Set(['home', 'shop', 'tavern', 'clinic', 'town_hall', 'bakery', 'workshop', 'pawnshop', 'divebar']);
/** Hands it takes to put a fire out. */
export const HELPERS_NEEDED = 3;
/** Within sight of the smoke (px): awake residents this close come running. */
const SIGHT_PX = 640;
/** Within earshot of the shouting (px): sleepers this close are woken. */
const EARSHOT_PX = 320;
/** The most a burnt-out owner loses in money (a quarter of what they have, capped). */
const MAX_MONEY_LOSS = 60;
/** Units of stock lost to the flames, at most. */
const MAX_STOCK_LOSS = 3;

interface Bystander {
  id: number;
  awake: boolean;
  distancePx: number;
  p: Pick<PersonalityProfile, 'warmth' | 'loyalty' | 'neuroticism'>;
}

/** Brave, dutiful or warm: runs toward the fire from anywhere in town. */
export function isBrave(p: Bystander['p']): boolean {
  return p.neuroticism < 45 && (p.loyalty > 65 || p.warmth > 65);
}

/** Cowardly or cold: watches from across the street, or stays away. */
export function isTimid(p: Bystander['p']): boolean {
  return p.neuroticism > 70 || p.warmth < 30;
}

/** How hard the fire pulls one bystander (pure: the tests say who comes). */
export function fireInviteLevel(b: Bystander): 'should' | 'may' | null {
  if (!b.awake) return b.distancePx <= EARSHOT_PX ? 'should' : null;
  if (isTimid(b.p)) return 'may';
  if (b.distancePx <= SIGHT_PX || isBrave(b.p)) return 'should';
  return 'may';
}

/** Put out or burned, by the hands that came (one roll when there were some, but too few). */
export function fireOutcome(helpers: number, roll: number): 'saved' | 'lost' {
  if (helpers >= HELPERS_NEEDED) return 'saved';
  if (helpers === 0) return 'lost';
  return roll < (helpers / HELPERS_NEEDED) * 0.6 ? 'saved' : 'lost';
}

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

/** Who loses by the fire: the place's owner, else the people living in it. */
export function ownersOf(locationId: number): number[] {
  const loc = db.select().from(locations).where(eq(locations.id, locationId)).get();
  if (!loc) return [];
  if (loc.owner != null && isActive(loc.owner)) return [loc.owner];
  return db.select({ id: agents.id, home: agents.home, active: agents.is_active }).from(agents).all()
    .filter((a) => a.active && a.home === locationId).map((a) => a.id);
}

/**
 * The building a fire breaks out in (the venue resolver on startWorldEvent): a
 * burnable building somebody owns or lives in, by the seeded dice of the minute
 * it starts. Null for a town with none (the event then burns nowhere in particular).
 */
export function pickFireBuilding(startedAtMin: number): number | null {
  const homes = new Set(db.select({ home: agents.home, active: agents.is_active }).from(agents).all()
    .filter((a) => a.active && a.home != null).map((a) => a.home!));
  const hosts = db.select().from(locations).all()
    .filter((l) => BURNABLE.has(l.type) && ((l.owner != null) || homes.has(l.id)))
    .sort((a, b) => a.id - b.id);
  if (hosts.length === 0) return null;
  return hosts[Math.floor(rngFor(`fire-venue|${startedAtMin}`)() * hosts.length)].id;
}

function placeName(g: Gathering): string {
  const loc = db.select({ name: locations.name, type: locations.type }).from(locations).where(eq(locations.id, g.venueLocationId)).get();
  if (!loc) return 'a house';
  if (loc.type === 'home' && g.hostIds.length > 0) return `${firstName(nameOf(g.hostIds[0]))}'s house`;
  return loc.name;
}

export const FIRE: GatheringKind = {
  id: 'fire',
  leadMin: 0,
  wakes: true,
  leavesShift: ['must', 'should'],
  mayChancePerMin: 0.01,
  encounterPerMin: 0.06,
  momentsAt: [50],
  invite(g) {
    for (const id of g.hostIds) invite(g, id, 'must', g.startMin);
    const venue = db.select().from(locations).where(eq(locations.id, g.venueLocationId)).get();
    if (!venue) return;
    const timid: number[] = [];
    const rows = db.select().from(agents).where(eq(agents.is_active, true)).all();
    for (const a of rows) {
      if (g.hostIds.includes(a.id) || a.age < 16) continue;
      const states = statesOf(a.id);
      if (states.includes('arrested') || states.includes('sick')) continue;
      const p = getEffectivePersonality(a.id) ?? (a.personality as PersonalityProfile | null);
      const b: Bystander = {
        id: a.id,
        awake: (a.current_action as { type?: string } | null)?.type !== 'sleeping',
        distancePx: Math.hypot(a.position.x - venue.entry_point.x, a.position.y - venue.entry_point.y),
        p: { warmth: p?.warmth ?? 50, loyalty: p?.loyalty ?? 50, neuroticism: p?.neuroticism ?? 50 },
      };
      const level = fireInviteLevel(b);
      if (!level) continue;
      invite(g, a.id, level, g.startMin);
      if (level === 'may' && isTimid(b.p)) timid.push(a.id);
    }
    g.payload.timid = timid;
    // The owner's close ties, for the resentment if it burns and they never came.
    const close = new Set<number>();
    for (const host of g.hostIds) {
      for (const c of gatherCandidates(host)) if (!c.hostile && holds(c, [...KIN, ...FRIENDS])) close.add(c.id);
    }
    g.payload.closeTies = [...close].filter((id) => !g.hostIds.includes(id));
  },
  onOpen(g, nowMin) {
    // The shouting wakes the street, and the bell calls people from their work:
    // end the sleep or shift of everyone asked to come, so their next decision
    // (the gathering phase) is taken now and not at their alarm or the end of the hour.
    const urgent = [...g.invited].filter(([, inv]) => inv.level !== 'may').map(([id]) => id);
    for (const id of urgent) {
      const a = db.select({ action: agents.current_action }).from(agents).where(eq(agents.id, id)).get();
      const type = (a?.action as { type?: string } | null)?.type;
      if (type === 'sleeping' || type === 'working' || type === 'idle' || type === 'eating') {
        db.update(agents).set({ action_started: nowMin, action_duration: 0 }).where(eq(agents.id, id)).run();
      }
    }
  },
  label(g) {
    const place = placeName(g);
    return { walking: `Running to the fire at ${place}`, there: `Fighting the fire at ${place}` };
  },
  topic: (g) => GATHERING_TOPIC.fire(placeName(g)),
  moment(g, present, nowMin) {
    const helpers = present.filter((id) => !(g.payload.timid as number[] | undefined)?.includes(id));
    const outcome = fireOutcome(helpers.length, rngFor(`fire|${g.id}`)());
    g.payload.outcome = outcome;
    g.payload.helpers = helpers;
    g.payload.watchers = present.filter((id) => !helpers.includes(id));
    const owner = g.hostIds[0];
    // Tired arms and smoke: the helpers' energy, through the needs row like any exertion.
    for (const id of helpers) {
      const n = db.select().from(needs).where(eq(needs.agent_id, id)).get();
      if (n) db.update(needs).set({ energy: Math.max(0, n.energy - 8) }).where(eq(needs.agent_id, id)).run();
    }
    if (outcome === 'saved') {
      endWrappedEvent(g);
      for (const h of helpers) {
        for (const o of g.hostIds) {
          if (h === o) continue;
          recordFavorGiven(h, o, 2);
          feel(o, h, 'fire_help', `${nameOf(h)} helped put out the fire`, {
            fromCaller: { friendship: 6, trust: 4 }, fromTarget: { friendship: 2 }, sentiment: 0.7,
          });
        }
        if (!g.hostIds.includes(h)) {
          adjustReputation(h, 2);
          remember(h, `I ran to the fire at ${placeName(g)} with a bucket, and we put it out.`, 0.5, 6, owner ?? h);
        }
      }
      for (const o of g.hostIds) {
        mood(o, 5, 'fire_saved', DAY, nowMin);
        remember(o, `My place caught fire, and ${nameList(helpers.filter((h) => h !== o).map((h) => firstName(nameOf(h))), 3) || 'the town'} came running and put it out. I owe them.`, 0.4, 8, helpers.find((h) => h !== o) ?? o);
      }
      return;
    }
    // Burned: real loss for the owner, and the close ties who never came are remembered.
    let lostMoney = 0;
    let lostStock = 0;
    for (const o of g.hostIds) {
      const econ = db.select().from(economy).where(eq(economy.agent_id, o)).get();
      if (!econ) continue;
      lostMoney += payTreasury(o, Math.min(MAX_MONEY_LOSS, Math.round(econ.money * 0.25)), 'fire:damage');
      let inv = db.select().from(economy).where(eq(economy.agent_id, o)).get()?.inventory ?? [];
      for (let i = 0; i < MAX_STOCK_LOSS && inv.length > 0; i++) {
        inv = removeFromInventory(inv, inv[0].itemId, 1);
        lostStock++;
      }
      db.update(economy).set({ inventory: inv }).where(eq(economy.agent_id, o)).run();
      mood(o, -15, 'fire_lost', 3 * DAY, nowMin);
      remember(o, `My place burned and ${helpers.length === 0 ? 'nobody came to help' : 'too few came to save it'}.`, -0.8, 9, helpers[0] ?? o);
    }
    g.payload.lostMoney = lostMoney;
    g.payload.lostStock = lostStock;
    const close = new Set((g.payload.closeTies as number[] | undefined) ?? []);
    const absent = [...close].filter((id) => !present.includes(id) && isActive(id) && !excused(id));
    for (const a of absent) {
      for (const o of g.hostIds) {
        feel(o, a, 'fire_absent', `${nameOf(a)} never came to the fire`, { fromCaller: { friendship: -4, trust: -3 }, fromTarget: {}, sentiment: -0.4 });
        remember(o, `${firstName(nameOf(a))} never came when my place was burning.`, -0.6, 7, a);
      }
    }
    g.payload.absentClose = absent;
  },
  onClose(g, att) {
    const place = placeName(g);
    const helpers = (g.payload.helpers as number[] | undefined) ?? [...att.attended];
    const watchers = ((g.payload.watchers as number[] | undefined) ?? []).filter((id) => !helpers.includes(id));
    const owner = g.hostIds[0];
    const outcome = g.payload.outcome === 'saved' ? 'saved' : g.payload.outcome === 'lost' ? 'lost' : null;
    const names = nameList(helpers.map(nameOf), 4);
    const parts: string[] = [];
    if (outcome === 'saved') {
      parts.push(`Fire at ${place}! ${helpers.length} came running with buckets — ${names} — and put it out.`);
      if (owner != null) parts.push(`${nameOf(owner)} is in their debt.`);
    } else if (outcome === 'lost') {
      parts.push(helpers.length === 0
        ? `Fire at ${place}, and nobody came to fight it: it burned.`
        : `Fire at ${place}: only ${names} came to help, and it burned.`);
      const money = Number(g.payload.lostMoney ?? 0);
      if (owner != null && (money > 0 || Number(g.payload.lostStock ?? 0) > 0)) {
        parts.push(`${nameOf(owner)} lost ${money > 0 ? `$${money}` : ''}${money > 0 && Number(g.payload.lostStock ?? 0) > 0 ? ' and ' : ''}${Number(g.payload.lostStock ?? 0) > 0 ? 'stock' : ''} to the flames.`);
      }
      const absent = ((g.payload.absentClose as number[] | undefined) ?? []);
      if (absent.length > 0) parts.push(`${nameList(absent.map(nameOf), 2)} never came.`);
    } else {
      parts.push(`Fire at ${place}; it burned itself out before anyone came.`);
    }
    if (watchers.length > 0) parts.push(`${nameList(watchers.map(nameOf), 2)} watched from across the street.`);
    gatheringFeed(g, outcome === 'saved' ? 'fire_saved' : 'fire_lost', parts.join(' '), outcome === 'saved' ? 0.9 : 1, [...helpers, ...watchers]);
  },
};

/** The fire event started (world:event_started): an urgent gathering at the burning building. */
export function onFireStarted(eventId: number, locationId: number | null, startedAtMin: number, durationHours: number): void {
  if (locationId == null) return;
  const loc = db.select({ type: locations.type }).from(locations).where(eq(locations.id, locationId)).get();
  if (!loc || !BURNABLE.has(loc.type)) return;
  const owners = ownersOf(locationId);
  scheduleGathering({
    kind: 'fire',
    venueLocationId: locationId,
    startMin: startedAtMin,
    endMin: startedAtMin + Math.min(durationHours * HOUR, 2 * HOUR),
    hostIds: owners,
    eventId,
  });
  // A fire is an ordeal: whoever owed the owner a kindness and never came is noticed.
  for (const o of owners) noteOrdeal(o, 'fire', startedAtMin);
}

/** A fire has to burn some building: the venue resolver startWorldEvent asks for a fire with no place. */
export function registerFireVenue(): void {
  setEventVenueResolver('fire_outbreak', pickFireBuilding);
}
