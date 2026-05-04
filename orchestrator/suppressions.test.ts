import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { dbFile } from "../cli/paths.ts";
import {
  cleanupSuppressions,
  isSuppressed,
  listSuppressions,
  suppress,
  unsuppress,
} from "./suppressions.ts";

describe("suppressions", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function db(): string {
    return dbFile(sandbox.dataDir);
  }

  it("isSuppressed returns false for an unknown patternId", () => {
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(false);
  });

  it("suppress + isSuppressed roundtrip", () => {
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "lodash CVE-2026-X — accepted risk",
    });
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(true);
  });

  it("expired suppressions count as inactive", () => {
    const past = new Date("2026-01-01T00:00:00Z");
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "expired",
      expiresAt: past.toISOString(),
    });
    // Now query with a "now" far in the future
    expect(
      isSuppressed(db(), "yarn-audit:CVE-X", new Date("2099-01-01T00:00:00Z")),
    ).toBe(false);
  });

  it("future-expiring suppressions are still active", () => {
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "expires soon",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(true);
  });

  it("unsuppress clears an active suppression", () => {
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "x",
    });
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(true);
    expect(unsuppress(db(), "yarn-audit:CVE-X")).toBe(true);
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(false);
  });

  it("unsuppress returns false when no active row exists", () => {
    expect(unsuppress(db(), "no-such-pattern")).toBe(false);
    // Suppress + unsuppress + unsuppress again — second is a no-op
    suppress(db(), { patternId: "x", pattern: "x" });
    expect(unsuppress(db(), "x")).toBe(true);
    expect(unsuppress(db(), "x")).toBe(false);
  });

  it("re-suppress after unsuppress restores the active state", () => {
    suppress(db(), { patternId: "yarn-audit:CVE-X", pattern: "first" });
    unsuppress(db(), "yarn-audit:CVE-X");
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(false);
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "remute",
      reason: "decided to actually fix this",
    });
    expect(isSuppressed(db(), "yarn-audit:CVE-X")).toBe(true);
  });

  it("listSuppressions defaults to active rows only", () => {
    suppress(db(), { patternId: "active1", pattern: "a" });
    suppress(db(), { patternId: "active2", pattern: "b" });
    suppress(db(), { patternId: "to-clear", pattern: "c" });
    unsuppress(db(), "to-clear");
    const active = listSuppressions(db());
    const ids = active.map((r) => r.patternId).sort();
    expect(ids).toEqual(["active1", "active2"]);
  });

  it("listSuppressions includes cleared when --all is set", () => {
    suppress(db(), { patternId: "live", pattern: "a" });
    suppress(db(), { patternId: "dead", pattern: "b" });
    unsuppress(db(), "dead");
    const all = listSuppressions(db(), { includeCleared: true });
    const ids = all.map((r) => r.patternId).sort();
    expect(ids).toEqual(["dead", "live"]);
    expect(all.find((r) => r.patternId === "dead")?.clearedAt).not.toBeNull();
  });

  it("listSuppressions excludes expired rows from the active view", () => {
    suppress(db(), {
      patternId: "expired",
      pattern: "x",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    const active = listSuppressions(
      db(),
      {},
      new Date("2099-01-01T00:00:00Z"),
    );
    expect(active.find((r) => r.patternId === "expired")).toBeUndefined();
  });

  it("cleanupSuppressions is a no-op when the table is empty", () => {
    expect(cleanupSuppressions(db())).toBe(0);
  });

  it("cleanupSuppressions never deletes active rows", () => {
    suppress(db(), { patternId: "live-no-expiry", pattern: "a" });
    suppress(db(), {
      patternId: "live-future-expiry",
      pattern: "b",
      expiresAt: "2099-12-31T00:00:00Z",
    });
    const removed = cleanupSuppressions(
      db(),
      {},
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(removed).toBe(0);
    const ids = listSuppressions(db(), {}, new Date("2026-05-01T00:00:00Z"))
      .map((r) => r.patternId)
      .sort();
    expect(ids).toEqual(["live-future-expiry", "live-no-expiry"]);
  });

  it("cleanupSuppressions removes cleared rows older than the retention window", () => {
    // Suppress + clear both rows; cleared_at = far past
    suppress(db(), { patternId: "old-cleared", pattern: "x" });
    unsuppress(db(), "old-cleared", new Date("2025-01-01T00:00:00Z"));
    suppress(db(), { patternId: "recent-cleared", pattern: "y" });
    unsuppress(db(), "recent-cleared", new Date("2026-04-15T00:00:00Z"));

    // 90d window from now=2026-05-01 ⇒ cutoff=2026-01-31. old-cleared is
    // before cutoff → deleted; recent-cleared is after → kept.
    const removed = cleanupSuppressions(
      db(),
      {},
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(removed).toBe(1);
    const remaining = listSuppressions(db(), { includeCleared: true });
    expect(remaining.map((r) => r.patternId)).toEqual(["recent-cleared"]);
  });

  it("cleanupSuppressions removes expired rows older than the retention window", () => {
    suppress(db(), {
      patternId: "long-expired",
      pattern: "x",
      expiresAt: "2025-01-01T00:00:00Z",
    });
    suppress(db(), {
      patternId: "recently-expired",
      pattern: "y",
      expiresAt: "2026-04-15T00:00:00Z",
    });
    suppress(db(), {
      patternId: "future-expiry",
      pattern: "z",
      expiresAt: "2099-01-01T00:00:00Z",
    });

    const removed = cleanupSuppressions(
      db(),
      {},
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(removed).toBe(1);
    const remaining = listSuppressions(
      db(),
      { includeCleared: true },
      new Date("2026-05-01T00:00:00Z"),
    )
      .map((r) => r.patternId)
      .sort();
    expect(remaining).toEqual(["future-expiry", "recently-expired"]);
  });

  it("cleanupSuppressions respects a custom olderThanDays", () => {
    suppress(db(), { patternId: "x", pattern: "x" });
    unsuppress(db(), "x", new Date("2026-04-25T00:00:00Z"));

    // 90-day window keeps it (cutoff = 2026-01-31)
    expect(
      cleanupSuppressions(db(), {}, new Date("2026-05-01T00:00:00Z")),
    ).toBe(0);

    // 1-day window deletes it (cutoff = 2026-04-30)
    expect(
      cleanupSuppressions(
        db(),
        { olderThanDays: 1 },
        new Date("2026-05-01T00:00:00Z"),
      ),
    ).toBe(1);
  });

  it("suppress is an upsert — calling twice on same id refreshes the row", () => {
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "first description",
      reason: "first reason",
    });
    suppress(db(), {
      patternId: "yarn-audit:CVE-X",
      pattern: "updated description",
      reason: "updated reason",
    });
    const all = listSuppressions(db());
    const row = all.find((r) => r.patternId === "yarn-audit:CVE-X");
    expect(row?.pattern).toBe("updated description");
    expect(row?.reason).toBe("updated reason");
  });
});
