import { describe, it, expect } from "vitest";
import { calendarChip, calendarDayTags } from "../calendarChip";

describe("calendarChip", () => {
  it("counts down to the next festival within two days", () => {
    // Spring Fair: spring day 9, 10:00 (server/data/calendar.ts).
    expect(calendarChip(7, 12)).toMatchObject({ icon: "🌸", label: "Spring Fair in 2 days" });
    expect(calendarChip(8, 20)).toMatchObject({ label: "Spring Fair tomorrow" });
  });

  it("says when it opens today, then that it is on, then moves on", () => {
    expect(calendarChip(9, 8)?.label).toBe("Spring Fair today at 10:00");
    expect(calendarChip(9, 12)?.label).toBe("Spring Fair — on now");
    // Closed at 16:00; day 10–11 hold nothing big, day 12 is a market.
    expect(calendarChip(9, 17)).toBeNull();
  });

  it("shows the election, and markets only when nothing bigger is near", () => {
    expect(calendarChip(22, 9)).toMatchObject({ icon: "🗳", label: "Election in 2 days" });
    expect(calendarChip(24, 17)?.label).toBe("Election — on now");
    expect(calendarChip(3, 9)).toMatchObject({ icon: "🧺", label: "Market Day in 2 days" });
    expect(calendarChip(13, 9)).toBeNull();
  });

  it("tags timeline days with what was on", () => {
    expect(calendarDayTags(9)).toEqual([{ icon: "🌸", name: "Spring Fair" }]);
    expect(calendarDayTags(24)).toEqual([{ icon: "🗳", name: "Election" }]);
    expect(calendarDayTags(22)).toEqual([]);
    expect(calendarDayTags(5)).toEqual([{ icon: "🧺", name: "Market Day" }]);
  });
});
