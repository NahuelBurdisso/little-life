import { describe, it, expect } from 'vitest';
import { activityFor, isAudienceActivity, isPerformerActivity, isShoppingTrip, type ActivityContext, type ActivityId } from '../activity';

const ctx = (over: Partial<ActivityContext>): ActivityContext => ({
  actionType: 'idle',
  zoneActivity: null,
  atWorkplace: false,
  workplaceType: null,
  nearOthers: false,
  ...over,
});

describe('activityFor — zone verbs', () => {
  const cases: Array<[string, ActivityId]> = [
    ['jog', 'jog'],
    ['comfort', 'comfort'],
    ['browse', 'browse'],
    ['shoplifting', 'shoplift'],
    ['pickpocket', 'pickpocket'],
    ['fish', 'fish'],
    ['garden', 'garden'],
    ['pick_flowers', 'tend'],
    ['plant', 'tend'],
    ['harvest', 'tend'],
    ['collect_eggs', 'feed'],
    ['feed_animals', 'feed'],
    ['forage', 'forage'],
    ['perform', 'perform'],
    ['watch', 'watch'],
    ['people_watch', 'watch'],
    ['speech', 'speech'],
    ['announce', 'speech'],
    ['protest', 'protest'],
    ['cook', 'cook'],
    ['scheme', 'scheme'],
    ['secret_meeting', 'scheme'],
    ['confide', 'confide'],
    ['contemplate', 'contemplate'],
    ['tryst', 'tryst'],
    ['sneak_home', 'sneak_home'],
  ];
  for (const [verb, activity] of cases) {
    it(`idle + ${verb} -> ${activity}`, () => {
      expect(activityFor(ctx({ zoneActivity: verb }))).toBe(activity);
    });
  }

  it('an unknown verb, or none, is plain idling', () => {
    expect(activityFor(ctx({ zoneActivity: 'moonwalk' }))).toBe('none');
    expect(activityFor(ctx({}))).toBe('none');
    expect(activityFor(ctx({ zoneActivity: 'rest' }))).toBe('none');
  });

  it('a comfort action is a cup of tea even without a zone tag', () => {
    expect(activityFor(ctx({ actionType: 'comfort' }))).toBe('comfort');
    expect(activityFor(ctx({ actionType: 'comfort', zoneActivity: 'comfort' }))).toBe('comfort');
    expect(activityFor(ctx({ actionType: 'comfort', zoneActivity: 'rest' }))).toBe('none');
  });

  it('the private evening and the dawn walk only count while idle (a sleeper is just asleep)', () => {
    for (const verb of ['tryst', 'sneak_home']) {
      for (const t of ['sleeping', 'walking', 'talking', 'working']) {
        expect(activityFor(ctx({ actionType: t, zoneActivity: verb })), `${t}+${verb}`).toBe('none');
      }
    }
  });

  it('a verb never overrides sleeping, walking or talking', () => {
    for (const t of ['sleeping', 'walking', 'talking', 'dead']) {
      expect(activityFor(ctx({ actionType: t, zoneActivity: 'fish' })), t).toBe('none');
    }
  });
});

describe('activityFor — actions', () => {
  it('eating and shopping', () => {
    expect(activityFor(ctx({ actionType: 'eating' }))).toBe('eating');
    expect(activityFor(ctx({ actionType: 'shopping' }))).toBe('shopping');
  });

  it('socializing only counts as mingling with company', () => {
    expect(activityFor(ctx({ actionType: 'socializing', nearOthers: true }))).toBe('mingle');
    expect(activityFor(ctx({ actionType: 'socializing', nearOthers: false }))).toBe('none');
  });

  const work: Array<[string, ActivityId]> = [
    ['bakery', 'work_bakery'],
    ['workshop', 'work_workshop'],
    ['shop', 'work_shop'],
    ['pawnshop', 'work_pawnshop'],
    ['town_hall', 'work_town_hall'],
    ['clinic', 'work_clinic'],
    ['tavern', 'work_tavern'],
    ['divebar', 'work_tavern'],
    ['farm', 'work_farm'],
  ];
  for (const [type, activity] of work) {
    it(`working at the ${type} -> ${activity}`, () => {
      expect(activityFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: type }))).toBe(activity);
    });
  }

  it('work only shows at the bench', () => {
    expect(activityFor(ctx({ actionType: 'working', atWorkplace: false, workplaceType: 'workshop' }))).toBe('none');
    expect(activityFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: 'prison' }))).toBe('none');
    expect(activityFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: null }))).toBe('none');
  });
});

describe('roles', () => {
  it('watchers look at performers, speakers and protesters', () => {
    expect(isAudienceActivity('watch')).toBe(true);
    expect(isAudienceActivity('perform')).toBe(false);
    for (const a of ['perform', 'speech', 'protest'] as const) expect(isPerformerActivity(a), a).toBe(true);
    expect(isPerformerActivity('watch')).toBe(false);
  });

  it('a shopping trip is shopping or browsing the stalls', () => {
    expect(isShoppingTrip('shopping', null)).toBe(true);
    expect(isShoppingTrip('idle', 'browse')).toBe(true);
    expect(isShoppingTrip('idle', 'fish')).toBe(false);
    expect(isShoppingTrip('walking', 'browse')).toBe(false);
    expect(isShoppingTrip('idle', null)).toBe(false);
  });
});
