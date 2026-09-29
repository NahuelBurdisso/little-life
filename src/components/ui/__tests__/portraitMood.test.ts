import { describe, it, expect } from "vitest";
import { portraitMood, portraitSrc, PORTRAIT_MOODS } from "../portraitMood";

const s = (...types: string[]) => types.map((type) => ({ type }));

describe("portraitMood", () => {
  it("is neutral with no states and a middling mood", () => {
    expect(portraitMood(50, [])).toBe("neutral");
    expect(portraitMood(undefined, undefined)).toBe("neutral");
    expect(portraitMood(25, s("stressed", "lonely"))).toBe("neutral");
    expect(portraitMood(75, [])).toBe("neutral");
  });

  it("angry and jealous read as angry", () => {
    expect(portraitMood(50, s("angry"))).toBe("angry");
    expect(portraitMood(50, s("jealous"))).toBe("angry");
  });

  it("heartbreak, grief, depression and a low mood read as sad", () => {
    expect(portraitMood(50, s("heartbroken"))).toBe("sad");
    expect(portraitMood(50, s("grieving"))).toBe("sad");
    expect(portraitMood(50, s("depressed"))).toBe("sad");
    expect(portraitMood(24, [])).toBe("sad");
  });

  it("euphoria, infatuation and a high mood read as happy", () => {
    expect(portraitMood(50, s("euphoric"))).toBe("happy");
    expect(portraitMood(50, s("infatuated"))).toBe("happy");
    expect(portraitMood(76, [])).toBe("happy");
  });

  it("an arrest reads as shocked, over everything else", () => {
    expect(portraitMood(90, s("arrested", "euphoric"))).toBe("shocked");
    expect(portraitMood(10, s("arrested", "angry"))).toBe("shocked");
  });

  it("angry beats sad, and states beat the mood number", () => {
    expect(portraitMood(10, s("angry"))).toBe("angry");
    expect(portraitMood(90, s("grieving"))).toBe("sad");
    expect(portraitMood(10, s("euphoric"))).toBe("happy");
  });

  it("sad beats happy when both apply", () => {
    expect(portraitMood(50, s("euphoric", "heartbroken"))).toBe("sad");
  });
});

describe("portraitSrc", () => {
  it("keeps the neutral file as is and suffixes the rest", () => {
    expect(portraitSrc("rosa_chen_portrait", "neutral")).toBe("/sprites/agents/rosa_chen_portrait.png");
    expect(portraitSrc("rosa_chen_portrait", "sad")).toBe("/sprites/agents/rosa_chen_portrait_sad.png");
  });

  it("lists every mood the art script produces", () => {
    expect([...PORTRAIT_MOODS].sort()).toEqual(["angry", "happy", "neutral", "sad", "shocked"]);
  });
});
