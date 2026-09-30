import { describe, expect, it } from "vitest";
import {
  FADE_MAX_ROW_AGE_MS, FADE_MIN_GAP_MS, createFadeState, fadeLine, fadeRequestFor, type FadeRow,
} from "../fadeTrigger";

const NOW = 1_000_000_000;
const tryst = (over: Partial<FadeRow> = {}): FadeRow => ({
  id: 10,
  type: "tryst",
  initiator_id: 1,
  target_id: 2,
  agent_ids: [1, 2],
  template_data: { agent1: "Rosa", agent2: "Marco", venue: "The Old Barn" },
  real_timestamp: NOW - 1000,
  ...over,
});
const none = new Set<string>();

describe("fadeRequestFor", () => {
  it("fades when the selected resident is in the tryst", () => {
    expect(fadeRequestFor([tryst()], "2", none, NOW, createFadeState())).toEqual({
      venue: "The Old Barn",
      names: ["Rosa", "Marco"],
    });
  });

  it("fades for a favourite, and stays quiet for strangers", () => {
    expect(fadeRequestFor([tryst()], null, new Set(["1"]), NOW, createFadeState())).not.toBeNull();
    expect(fadeRequestFor([tryst()], "7", new Set(["8"]), NOW, createFadeState())).toBeNull();
    expect(fadeRequestFor([tryst()], null, none, NOW, createFadeState())).toBeNull();
  });

  it("recognises the pair from initiator/target alone or from agent_ids alone", () => {
    const s = () => createFadeState();
    expect(fadeRequestFor([tryst({ agent_ids: null })], "1", none, NOW, s())).not.toBeNull();
    expect(fadeRequestFor([tryst({ initiator_id: null, target_id: null })], "2", none, NOW, s())).not.toBeNull();
  });

  it("only trysts fade the screen", () => {
    for (const type of ["kiss", "first_kiss", "caught", "scandal", "drama", "engagement"]) {
      expect(fadeRequestFor([tryst({ type })], "1", none, NOW, createFadeState())).toBeNull();
    }
  });

  it("never fires for old rows, but a row with no timestamp counts as fresh", () => {
    const old = tryst({ real_timestamp: NOW - FADE_MAX_ROW_AGE_MS - 1 });
    expect(fadeRequestFor([old], "1", none, NOW, createFadeState())).toBeNull();
    const edge = tryst({ real_timestamp: NOW - FADE_MAX_ROW_AGE_MS });
    expect(fadeRequestFor([edge], "1", none, NOW, createFadeState())).not.toBeNull();
    const undated = tryst({ real_timestamp: undefined });
    expect(fadeRequestFor([undated], "1", none, NOW, createFadeState())).not.toBeNull();
  });

  it("skips a stale row and takes the fresh one behind it", () => {
    const old = tryst({ id: 1, real_timestamp: NOW - 5 * 60_000 });
    const fresh = tryst({ id: 2, template_data: { agent1: "Ana", agent2: "Bo", venue: "The Barn" } });
    expect(fadeRequestFor([old, fresh], "1", none, NOW, createFadeState())?.venue).toBe("The Barn");
  });

  it("at most once per 20 s of wall clock", () => {
    const state = createFadeState();
    expect(fadeRequestFor([tryst({ id: 1 })], "1", none, NOW, state)).not.toBeNull();
    expect(fadeRequestFor([tryst({ id: 2 })], "1", none, NOW + FADE_MIN_GAP_MS - 1, state)).toBeNull();
    expect(fadeRequestFor([tryst({ id: 3 })], "1", none, NOW + FADE_MIN_GAP_MS, state)).not.toBeNull();
  });

  it("a suppressed row does not start the cooldown", () => {
    const state = createFadeState();
    expect(fadeRequestFor([tryst()], "7", none, NOW, state)).toBeNull();
    expect(state.lastFadeAt).toBeNull();
    expect(fadeRequestFor([tryst()], "1", none, NOW + 1, state)).not.toBeNull();
  });

  it("two trysts in one batch make one request", () => {
    const state = createFadeState();
    const out = fadeRequestFor([tryst({ id: 1 }), tryst({ id: 2 })], "1", none, NOW, state);
    expect(out).not.toBeNull();
    expect(fadeRequestFor([], "1", none, NOW, state)).toBeNull();
  });

  it("a row without a venue still fades, with no place named", () => {
    const row = tryst({ template_data: { agent1: "Rosa", agent2: "Marco" } });
    expect(fadeRequestFor([row], "1", none, NOW, createFadeState())).toEqual({ venue: null, names: ["Rosa", "Marco"] });
  });
});

describe("fadeLine", () => {
  it("names the place when there is one", () => {
    expect(fadeLine({ venue: "The Barn", names: [] })).toBe("The lamp at The Barn is turned down.");
  });

  it("falls back to a nameless lamp", () => {
    expect(fadeLine({ venue: null, names: ["A", "B"] })).toBe("Somewhere, a lamp is turned down.");
  });
});
