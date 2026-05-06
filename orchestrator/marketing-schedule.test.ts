import { describe, expect, it } from "vitest";
import type { ScheduleRule } from "./brain.ts";
import {
  DEFAULT_FALLBACK_TIME_UTC,
  MarketingScheduleError,
  resolveScheduledAt,
} from "./marketing-schedule.ts";

describe("resolveScheduledAt — fallback (no rule)", () => {
  it("uses 09:00 UTC when no rule is provided", () => {
    const r = resolveScheduledAt({ date: "2026-04-08" });
    expect(r.scheduledAt).toBe(`2026-04-08T${DEFAULT_FALLBACK_TIME_UTC}`);
    expect(r.pushedByDays).toBe(0);
  });

  it("rejects malformed date strings", () => {
    expect(() => resolveScheduledAt({ date: "April 8" })).toThrow(
      MarketingScheduleError,
    );
    expect(() => resolveScheduledAt({ date: "2026-4-8" })).toThrow(
      MarketingScheduleError,
    );
  });
});

describe("resolveScheduledAt — preferredHours + timezone", () => {
  it("UTC rule applies preferredHours[0] verbatim", () => {
    const rule: ScheduleRule = {
      preferredHours: ["13:30"],
      timezone: "UTC",
    };
    const r = resolveScheduledAt({ date: "2026-04-08", rule });
    expect(r.scheduledAt).toBe("2026-04-08T13:30:00.000Z");
  });

  it("Europe/Budapest summer (CEST = UTC+2) shifts back by 2h", () => {
    // 2026-07-15 is in summer DST: CEST = UTC+2.
    // Wall-clock 09:00 Budapest = 07:00 UTC.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "Europe/Budapest",
    };
    const r = resolveScheduledAt({ date: "2026-07-15", rule });
    expect(r.scheduledAt).toBe("2026-07-15T07:00:00.000Z");
  });

  it("Europe/Budapest winter (CET = UTC+1) shifts back by 1h", () => {
    // 2026-12-15 is winter: CET = UTC+1.
    // Wall-clock 09:00 Budapest = 08:00 UTC.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "Europe/Budapest",
    };
    const r = resolveScheduledAt({ date: "2026-12-15", rule });
    expect(r.scheduledAt).toBe("2026-12-15T08:00:00.000Z");
  });

  it("America/New_York (EST = UTC-5) shifts forward", () => {
    // 2026-01-15 EST: 14:00 NY = 19:00 UTC.
    const rule: ScheduleRule = {
      preferredHours: ["14:00"],
      timezone: "America/New_York",
    };
    const r = resolveScheduledAt({ date: "2026-01-15", rule });
    expect(r.scheduledAt).toBe("2026-01-15T19:00:00.000Z");
  });

  it("rejects malformed preferredHours", () => {
    const rule: ScheduleRule = {
      preferredHours: ["9:00"], // missing leading zero
      timezone: "UTC",
    };
    expect(() =>
      resolveScheduledAt({ date: "2026-04-08", rule }),
    ).toThrow(/HH:MM/);
  });

  it("rejects unknown IANA timezone", () => {
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "Atlantis/Lost",
    };
    expect(() =>
      resolveScheduledAt({ date: "2026-04-08", rule }),
    ).toThrow(/timezone/);
  });
});

describe("resolveScheduledAt — allowedDays", () => {
  it("pushes forward past disallowed weekdays", () => {
    // 2026-04-12 is a Sunday. Allowed: mon-fri. Should push to mon 2026-04-13.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      allowedDays: ["mon", "tue", "wed", "thu", "fri"],
    };
    const r = resolveScheduledAt({ date: "2026-04-12", rule });
    expect(r.scheduledAt).toBe("2026-04-13T09:00:00.000Z");
    expect(r.pushedByDays).toBe(1);
    expect(r.pushReason).toBe("disallowed-day");
  });

  it("doesn't push when entry day is allowed", () => {
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      allowedDays: ["mon", "tue", "wed", "thu", "fri"],
    };
    // 2026-04-13 is Monday.
    const r = resolveScheduledAt({ date: "2026-04-13", rule });
    expect(r.pushedByDays).toBe(0);
    expect(r.pushReason).toBeUndefined();
  });

  it("multiple disallowed days in a row push correctly", () => {
    // sat 2026-04-11 → mon 2026-04-13 (skip sun): 2 days.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      allowedDays: ["mon", "tue", "wed", "thu", "fri"],
    };
    const r = resolveScheduledAt({ date: "2026-04-11", rule });
    expect(r.scheduledAt.startsWith("2026-04-13")).toBe(true);
    expect(r.pushedByDays).toBe(2);
  });

  it("throws when no allowed day exists within maxPushDays", () => {
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      allowedDays: [], // nothing allowed → infinite push, must fail loud
    };
    expect(() =>
      resolveScheduledAt({ date: "2026-04-08", rule, maxPushDays: 7 }),
    ).toThrow(/allowed day/);
  });
});

describe("resolveScheduledAt — blackoutDates", () => {
  it("pushes past a single blackout date", () => {
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      blackoutDates: ["2026-04-08"],
    };
    const r = resolveScheduledAt({ date: "2026-04-08", rule });
    expect(r.scheduledAt.startsWith("2026-04-09")).toBe(true);
    expect(r.pushedByDays).toBe(1);
    expect(r.pushReason).toBe("blackout-date");
  });

  it("blackout pushes through allowedDays correctly", () => {
    // 2026-04-13 is Monday (allowed) but blacked out.
    // Tuesday 2026-04-14 is allowed → push 1 day.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      allowedDays: ["mon", "tue", "wed", "thu", "fri"],
      blackoutDates: ["2026-04-13"],
    };
    const r = resolveScheduledAt({ date: "2026-04-13", rule });
    expect(r.scheduledAt.startsWith("2026-04-14")).toBe(true);
    expect(r.pushedByDays).toBe(1);
  });

  it("multiple consecutive blackouts push appropriately", () => {
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      blackoutDates: ["2026-12-24", "2026-12-25", "2026-12-26"],
    };
    const r = resolveScheduledAt({ date: "2026-12-24", rule });
    expect(r.scheduledAt.startsWith("2026-12-27")).toBe(true);
    expect(r.pushedByDays).toBe(3);
  });

  it("throws when blackouts exceed maxPushDays", () => {
    const blackoutDates: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const d = new Date(`2026-04-08T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + i);
      blackoutDates.push(d.toISOString().slice(0, 10));
    }
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "UTC",
      blackoutDates,
    };
    expect(() =>
      resolveScheduledAt({ date: "2026-04-08", rule, maxPushDays: 14 }),
    ).toThrow(/allowed day/);
  });
});

describe("resolveScheduledAt — DST boundary", () => {
  it("handles spring-forward DST in Europe/Budapest", () => {
    // 2026-03-29 is the last Sunday of March in CEST.
    // CET → CEST happens at 02:00 → 03:00 local time.
    // 09:00 Budapest after the shift = 07:00 UTC.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "Europe/Budapest",
    };
    const r = resolveScheduledAt({ date: "2026-03-30", rule });
    expect(r.scheduledAt).toBe("2026-03-30T07:00:00.000Z");
  });

  it("handles fall-back DST in Europe/Budapest", () => {
    // 2026-10-25 is the last Sunday of October when CEST → CET.
    // 09:00 Budapest after fall-back = 08:00 UTC.
    const rule: ScheduleRule = {
      preferredHours: ["09:00"],
      timezone: "Europe/Budapest",
    };
    const r = resolveScheduledAt({ date: "2026-10-26", rule });
    expect(r.scheduledAt).toBe("2026-10-26T08:00:00.000Z");
  });
});
