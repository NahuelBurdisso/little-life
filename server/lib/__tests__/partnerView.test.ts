import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db';
import { agentStates, shared_knowledge } from '../../db/schema';
import {
  clearPartnerNews, newsKeyOf, notePartnerNews, partnerViewFor, partnerViewLine, pronounsFor,
} from '../partnerView';
import { clearFactions, startFeud } from '../factions/store';
import { buildConversationPrompt } from '../../ai/prompts';
import { NOW, freshTown, insertResident, relate } from './populationFixtures';

const she = pronounsFor('female');

describe('partnerViewLine: what you can see of them, in one or two short lines', () => {
  it('says nothing when there is nothing to see', () => {
    expect(partnerViewLine({}, 'Elena', she)).toBeNull();
  });

  it('visible states on one line, known things on the other', () => {
    const line = partnerViewLine({
      sick: true, grievingFor: 'Tomas', justReleased: true, inDebt: true,
      feud: { role: 'side', withName: 'Ana', other: 'Ben', speaker: 'opposite' },
    }, 'Elena', she)!;
    expect(line).toBe([
      '[You can see] Elena looks ill and is in mourning for Tomas.',
      "[You know] She is just out of jail, she is in debt and she took Ana's side against Ben, and you are on the other side.",
    ].join('\n'));
  });

  it('a principal speaking to someone on their own side', () => {
    expect(partnerViewLine({ feud: { role: 'side', withName: 'you', other: 'Ben', speaker: 'none' } }, 'Ana', she))
      .toBe('[You know] She took your side against Ben.');
    expect(partnerViewLine({ birthday: true }, 'Ana', pronounsFor('male'))).toBe('[You know] It is his birthday today.');
  });

  it('the template tier gets the most pressing piece of news', () => {
    expect(newsKeyOf({ justReleased: true, birthday: true })).toBe('released');
    expect(newsKeyOf({ birthday: true })).toBe('birthday');
    expect(newsKeyOf({ sick: true })).toBeNull();
  });
});

describe('partnerViewFor: only what the speaker could plausibly know', () => {
  let town: ReturnType<typeof freshTown>;
  let speaker: number, other: number, stranger: number, kid: number;
  beforeEach(() => {
    town = freshTown();
    clearPartnerNews();
    clearFactions();
    speaker = insertResident('Ana Gil', town.homes[0]);
    other = insertResident('Elena Ruiz', town.homes[1]);
    stranger = insertResident('Bea Cruz', town.homes[2]);
    kid = insertResident('Kiko Gil', town.homes[0], { age: 12 });
    relate(speaker, other, { friendship_ab: 60, friendship_ba: 60 });
  });

  it('sees illness and mourning at a glance, whoever they are', () => {
    const dead = insertResident('Tomas Ruiz', town.homes[1], { is_active: false });
    db.insert(agentStates).values([
      { agent_id: other, type: 'sick', severity: 0.6, started_at: NOW, duration: 999, source: 'test', metadata: null },
      { agent_id: other, type: 'grieving', severity: 0.8, started_at: NOW, duration: 999, source: `event:death_of_${dead}`, metadata: null },
    ]).run();
    expect(partnerViewFor(stranger, other, NOW)).toMatchObject({ sick: true, grievingFor: 'Tomas' });
  });

  it('just out of jail only if they hold the fact; a birthday only for those close to them', () => {
    notePartnerNews(other, 'released', NOW - 60);
    notePartnerNews(other, 'birthday', NOW - 60);
    db.insert(shared_knowledge).values({
      type: 'released', subject_id: other, target_id: null, content: 'x', sensitivity: 1, known_by: [other, speaker], created_at: 0, source: 'event',
    }).run();
    expect(partnerViewFor(speaker, other, NOW)).toMatchObject({ justReleased: true, birthday: true });
    const strangerView = partnerViewFor(stranger, other, NOW);
    expect(strangerView.justReleased).toBeUndefined();
    expect(strangerView.birthday).toBeUndefined();
    // Old news is not news.
    expect(partnerViewFor(speaker, other, NOW + 5 * 24 * 60).justReleased).toBeUndefined();
  });

  it('a feud: known to those in it, public once it splits the town; never to a child when it grew from a betrayal', () => {
    const f = startFeud({
      aId: other, bId: stranger, cause: 'affair_discovered', causeText: 'a betrayal', culprit: 'b', culpritKnownBy: [],
      adultCause: true, nowMin: NOW, population: 4,
    })!;
    expect(partnerViewFor(speaker, other, NOW).feud).toBeUndefined();
    f.stances.set(speaker, 'a');
    expect(partnerViewFor(speaker, other, NOW).feud).toEqual({ role: 'principal', withName: 'Elena', other: 'Bea', speaker: 'same' });
    f.townSinceMin = NOW;
    f.stances.set(kid, 'neutral');
    expect(partnerViewFor(kid, other, NOW).feud).toBeUndefined();
    // The cause is never named.
    const line = partnerViewLine(partnerViewFor(speaker, other, NOW), 'Elena', she)!;
    expect(line).not.toMatch(/betray|affair/i);
  });

  it('lands in the dialogue prompt right after who they are talking to', () => {
    const prompt = buildConversationPrompt({
      speaker: { id: 1, name: 'Ana Gil', age: 30, gender: 'female', traits: [], personality: null } as never,
      speakerNeeds: { mood: 60, hunger: 70, energy: 70, social: 60, fun: 60 } as never,
      speakerEcon: { job_title: 'Baker', money: 50 } as never,
      conversation: { topic: 'catching up', messages: [], max_turns: 6 } as never,
      relationship: null,
      otherAgent: { id: 2, name: 'Elena Ruiz', gender: 'female', age: 40 } as never,
      memories: [],
      world: { time: { totalTicks: 100, hour: 10, minute: 0, day: 3, season: 'spring' }, weather: 'sunny', day_phase: 'morning' } as never,
      location: { name: 'The Square' } as never,
      partnerLine: '[You can see] Elena looks ill.',
    });
    const first = prompt.messages[0].content.split('\n');
    const i = first.findIndex((l) => l.startsWith("You're talking to"));
    expect(first[i + 1]).toBe('[You can see] Elena looks ill.');
  });
});
