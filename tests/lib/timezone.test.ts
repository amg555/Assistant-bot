import { describe, it, expect } from "vitest";
import {
  isValidTimeZone,
  zonedWallTimeToUtc,
  nextOccurrenceOfClockTime,
  getLocalHourAndDateKey,
} from "../../src/lib/timezone.js";

describe("isValidTimeZone", () => {
  it("accepts canonical IANA names", () => {
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("accepts long-standing aliases not in the canonical list", () => {
    // Asia/Kolkata is a widely-used alias for Asia/Calcutta that Node's
    // ICU data resolves, even though Intl.supportedValuesOf("timeZone")
    // does not list it explicitly.
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("rejects garbage input", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("banana")).toBe(false);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("converts IST (UTC+5:30, no DST) correctly", () => {
    // 9:00 AM IST on 2026-07-06 should be 03:30 UTC same day.
    const result = zonedWallTimeToUtc(2026, 7, 6, 9, 0, "Asia/Kolkata");
    expect(result.toISOString()).toBe("2026-07-06T03:30:00.000Z");
  });

  it("converts America/New_York correctly during DST (EDT, UTC-4)", () => {
    // July is within US daylight saving time.
    const result = zonedWallTimeToUtc(2026, 7, 6, 9, 0, "America/New_York");
    expect(result.toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  it("converts America/New_York correctly outside DST (EST, UTC-5)", () => {
    // January is standard time, not daylight saving.
    const result = zonedWallTimeToUtc(2026, 1, 6, 9, 0, "America/New_York");
    expect(result.toISOString()).toBe("2026-01-06T14:00:00.000Z");
  });

  it("handles UTC identity conversion", () => {
    const result = zonedWallTimeToUtc(2026, 3, 15, 12, 30, "UTC");
    expect(result.toISOString()).toBe("2026-03-15T12:30:00.000Z");
  });
});

describe("nextOccurrenceOfClockTime", () => {
  it("returns today's occurrence if the time hasn't passed yet locally", () => {
    // 2026-07-05T01:00:00Z = 06:30 IST — before 9am IST, so "today" applies.
    const now = new Date("2026-07-05T01:00:00Z");
    const result = nextOccurrenceOfClockTime("9am", "Asia/Kolkata", now);
    expect(result?.toISOString()).toBe("2026-07-05T03:30:00.000Z");
  });

  it("rolls forward to tomorrow if the time already passed locally", () => {
    // 2026-07-05T10:00:00Z = 15:30 IST — after 9am IST, so roll to tomorrow.
    const now = new Date("2026-07-05T10:00:00Z");
    const result = nextOccurrenceOfClockTime("9am", "Asia/Kolkata", now);
    expect(result?.toISOString()).toBe("2026-07-06T03:30:00.000Z");
  });

  it("parses 24-hour clock times", () => {
    // At 2026-07-05T01:00:00Z, local NY time is 21:00 EDT on July 4th
    // (not July 5th) — EDT is UTC-4. The requested 21:30 hasn't passed
    // yet locally (21:00 < 21:30), so "today" in NY-local terms is
    // still July 4th, and 21:30 EDT on July 4th converts to
    // 2026-07-05T01:30:00Z, not the 6th.
    const now = new Date("2026-07-05T01:00:00Z");
    const result = nextOccurrenceOfClockTime("21:30", "America/New_York", now);
    expect(result?.toISOString()).toBe("2026-07-05T01:30:00.000Z");
  });

  it("parses minute-precision am/pm times", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    const result = nextOccurrenceOfClockTime("9:15pm", "UTC", now);
    expect(result?.toISOString()).toBe("2026-07-05T21:15:00.000Z");
  });

  it("handles the 12am/12pm edge cases correctly", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    // 12am should mean midnight (hour 0), not noon.
    const midnight = nextOccurrenceOfClockTime("12am", "UTC", now);
    expect(midnight?.getUTCHours()).toBe(0);

    // 12pm should mean noon (hour 12), not midnight.
    const noon = nextOccurrenceOfClockTime("12pm", "UTC", now);
    expect(noon?.getUTCHours()).toBe(12);
  });

  it("returns null for unrecognizable input", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    expect(nextOccurrenceOfClockTime("banana", "UTC", now)).toBeNull();
    expect(nextOccurrenceOfClockTime("25:00", "UTC", now)).toBeNull();
    expect(nextOccurrenceOfClockTime("", "UTC", now)).toBeNull();
  });

  it("rejects a 12-hour value paired with am/pm outside the valid 1-12 range", () => {
    // Regression test: an earlier version of this function only checked
    // `hour > 23` unconditionally, which silently accepted nonsensical
    // combinations like "15am" or "13pm" instead of rejecting them.
    const now = new Date("2026-07-05T00:00:00Z");
    expect(nextOccurrenceOfClockTime("13pm", "UTC", now)).toBeNull();
    expect(nextOccurrenceOfClockTime("15am", "UTC", now)).toBeNull();
    expect(nextOccurrenceOfClockTime("0am", "UTC", now)).toBeNull();
  });

  it("still accepts valid 24-hour values with no am/pm suffix", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    expect(nextOccurrenceOfClockTime("23:00", "UTC", now)).not.toBeNull();
    expect(nextOccurrenceOfClockTime("0:00", "UTC", now)).not.toBeNull();
  });
});

describe("getLocalHourAndDateKey", () => {
  it("computes the correct local hour and date for a simple offset", () => {
    // 2026-07-05T03:00:00Z = 08:30 IST same day.
    const result = getLocalHourAndDateKey("Asia/Kolkata", new Date("2026-07-05T03:00:00Z"));
    expect(result).toEqual({ hour: 8, dateKey: "2026-07-05" });
  });

  it("correctly rolls the date forward across a timezone's midnight boundary", () => {
    // 2026-07-05T19:00:00Z + 5:30 = 2026-07-06T00:30 IST.
    const result = getLocalHourAndDateKey("Asia/Kolkata", new Date("2026-07-05T19:00:00Z"));
    expect(result).toEqual({ hour: 0, dateKey: "2026-07-06" });
  });

  it("matches UTC directly when timezone is UTC", () => {
    const result = getLocalHourAndDateKey("UTC", new Date("2026-07-05T08:00:00Z"));
    expect(result).toEqual({ hour: 8, dateKey: "2026-07-05" });
  });
});
