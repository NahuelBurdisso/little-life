import { describe, it, expect } from "vitest";
import { dayOfMinute, mergeTimelinePages, relativeDay, subjectOf } from "../timeline";
import type { TimelineDay, TimelinePage } from "../timeline";

const day = (n: number, ids: number[], headline: string | null = null): TimelineDay => ({
  day: n,
  season: "spring",
  headline,
  events: ids.map((id) => ({ id }) as TimelineDay["events"][number]),
});
const page = (days: TimelineDay[], nextCursor: number | null = null): TimelinePage => ({ days, nextCursor });

describe("mergeTimelinePages", () => {
  it("concatenates pages of whole days in order", () => {
    const days = mergeTimelinePages([page([day(5, [9]), day(4, [8])], 8), page([day(3, [7])])]);
    expect(days.map((d) => d.day)).toEqual([5, 4, 3]);
  });

  it("joins a day the server had to cut across two pages", () => {
    const days = mergeTimelinePages([page([day(5, [9, 8])], 8), page([day(5, [7], "Baker Weds Smith"), day(4, [6])])]);
    expect(days.map((d) => d.day)).toEqual([5, 4]);
    expect(days[0].events.map((e) => e.id)).toEqual([9, 8, 7]);
    expect(days[0].headline).toBe("Baker Weds Smith");
  });

  it("handles no pages", () => {
    expect(mergeTimelinePages([])).toEqual([]);
  });
});

describe("subjectOf", () => {
  it("prefers the first listed agent, like the live feed", () => {
    expect(subjectOf({ agent_ids: [4, 9], initiator_id: 9 })).toBe(4);
  });

  it("falls back to initiator then target when agent_ids is empty", () => {
    expect(subjectOf({ agent_ids: [], initiator_id: null, target_id: 6 })).toBe(6);
    expect(subjectOf({ agent_ids: [], initiator_id: 3, target_id: 6 })).toBe(3);
  });

  it("skips the resident whose story is open", () => {
    expect(subjectOf({ agent_ids: [4, 9] }, 4)).toBe(9);
    expect(subjectOf({ agent_ids: [4], initiator_id: 4 }, 4)).toBeNull();
  });

  it("returns null for a row about nobody", () => {
    expect(subjectOf({ agent_ids: [] })).toBeNull();
  });
});

describe("relativeDay / dayOfMinute", () => {
  it("names today and yesterday, counts the rest", () => {
    expect(relativeDay(7, 7)).toBe("today");
    expect(relativeDay(6, 7)).toBe("yesterday");
    expect(relativeDay(2, 7)).toBe("5 days ago");
    // A stale client clock must not print "-1 days ago".
    expect(relativeDay(8, 7)).toBe("today");
  });

  it("buckets a game minute the way the server does", () => {
    expect(dayOfMinute(1439)).toBe(0);
    expect(dayOfMinute(1440)).toBe(1);
  });
});
