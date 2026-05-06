import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insertScheduledPost,
  listScheduledPosts,
  type ScheduledPostInput,
} from "../../orchestrator/scheduled-posts.ts";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runPosts } from "./posts.ts";

function row(
  id: string,
  overrides: Partial<ScheduledPostInput> = {},
): ScheduledPostInput {
  return {
    id,
    planId: "plan-1",
    appId: "demo",
    channel: "facebook",
    content: "hello world",
    assets: [],
    scheduledAt: "2026-04-08T09:00:00.000Z",
    ...overrides,
  };
}

describe("runPosts (router)", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("rejects unknown subcommand", async () => {
    expect(await runPosts(["frobnicate"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("unknown subcommand");
  });

  it("requires a subcommand", async () => {
    expect(await runPosts([])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("missing subcommand");
  });
});

describe("posts list", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1"));
      insertScheduledPost(
        db,
        row("p2", {
          planId: "plan-2",
          channel: "instagram",
          scheduledAt: "2026-04-09T09:00:00.000Z",
        }),
      );
      insertScheduledPost(db, row("p3", { status: "published", appId: "other" }));
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("prints all rows by default", async () => {
    const code = await runPosts(["list"]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("p1");
    expect(out).toContain("p2");
    expect(out).toContain("p3");
  });

  it("filters by --plan", async () => {
    await runPosts(["list", "--plan", "plan-1"]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("p1");
    expect(out).not.toContain("p2");
  });

  it("filters by --status", async () => {
    await runPosts(["list", "--status", "published"]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("p3");
    expect(out).not.toContain("p1");
  });

  it("rejects invalid --status", async () => {
    expect(await runPosts(["list", "--status", "frobnicated"])).toBe(1);
  });

  it("emits valid JSON in --format json", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const code = await runPosts(["list", "--format", "json"]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed: unknown = JSON.parse(written.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as unknown[]).length).toBeGreaterThan(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("rejects invalid --limit", async () => {
    expect(await runPosts(["list", "--limit", "abc"])).toBe(1);
  });

  it("respects --limit", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runPosts(["list", "--limit", "1", "--format", "json"]);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed = JSON.parse(written.trim()) as unknown[];
      expect(parsed).toHaveLength(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("prints an empty marker when no rows match", async () => {
    await runPosts(["list", "--app", "no-such-app"]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("No scheduled posts");
  });
});

describe("posts edit", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posts-edit-test-"));
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1", { content: "original" }));
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires <post-id>", async () => {
    expect(await runPosts(["edit"])).toBe(1);
  });

  it("requires --inline or --file", async () => {
    expect(await runPosts(["edit", "p1"])).toBe(1);
  });

  it("rejects --inline + --file together", async () => {
    expect(
      await runPosts(["edit", "p1", "--inline", "x", "--file", "/tmp/x"]),
    ).toBe(1);
  });

  it("updates content from --inline + records post-edited event", async () => {
    const code = await runPosts(["edit", "p1", "--inline", "rewritten"]);
    expect(code).toBe(0);
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
      expect(updated?.content).toBe("rewritten");
      expect(updated?.status).toBe("edited");
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'post-edited'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("updates content from --file", async () => {
    const file = path.join(tmpDir, "new.txt");
    fs.writeFileSync(file, "from file");
    expect(await runPosts(["edit", "p1", "--file", file])).toBe(0);
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      expect(
        listScheduledPosts(db, { planId: "plan-1" })[0]?.content,
      ).toBe("from file");
    } finally {
      db.close();
    }
  });

  it("rejects --file path that does not exist", async () => {
    expect(
      await runPosts(["edit", "p1", "--file", path.join(tmpDir, "missing.txt")]),
    ).toBe(1);
  });

  it("returns 1 when row is not found", async () => {
    expect(await runPosts(["edit", "ghost", "--inline", "x"])).toBe(1);
  });

  it("no-op when content matches existing", async () => {
    const code = await runPosts(["edit", "p1", "--inline", "original"]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("no change");
  });

  it("refuses on already-published rows", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("pub", { status: "published" }));
    } finally {
      db.close();
    }
    expect(await runPosts(["edit", "pub", "--inline", "x"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("published");
  });
});

describe("posts approve", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires <post-id>", async () => {
    expect(await runPosts(["approve"])).toBe(1);
  });

  it("flips awaiting-review → pending + records post-approved event", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1", { status: "awaiting-review" }));
    } finally {
      db.close();
    }
    const code = await runPosts(["approve", "p1"]);
    expect(code).toBe(0);
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      expect(listScheduledPosts(verifyDb)[0]?.status).toBe("pending");
      const events = verifyDb
        .prepare("SELECT payload FROM events WHERE kind = 'post-approved'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
    } finally {
      verifyDb.close();
    }
  });

  it("returns 1 when row is not found", async () => {
    expect(await runPosts(["approve", "ghost"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("not found");
  });

  it("refuses on published rows", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("pub", { status: "published" }));
    } finally {
      db.close();
    }
    expect(await runPosts(["approve", "pub"])).toBe(1);
  });
});

describe("posts publish-due", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("publishes due rows + reports counts", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1"));
    } finally {
      db.close();
    }
    const code = await runPosts(["publish-due"], {
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Examined 1 due post(s)");
    expect(out).toContain("✓ p1 → stub-p1");
  });

  it("reports nothing when no rows are due", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("future", {
        scheduledAt: "2027-01-01T00:00:00.000Z",
      }));
    } finally {
      db.close();
    }
    const code = await runPosts(["publish-due"], {
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("No due pending posts");
  });

  it("rejects invalid --limit", async () => {
    expect(
      await runPosts(["publish-due", "--limit", "abc"], {
        now: new Date("2026-04-09T00:00:00.000Z"),
      }),
    ).toBe(1);
  });

  it("respects --limit", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      for (let i = 0; i < 5; i += 1) {
        insertScheduledPost(db, row(`p${i}`, {
          scheduledAt: `2026-04-0${(i % 9) + 1}T09:00:00.000Z`,
        }));
      }
    } finally {
      db.close();
    }
    const code = await runPosts(["publish-due", "--limit", "2"], {
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Examined 2 due post(s)");
  });
});

describe("posts skip", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1"));
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires <post-id>", async () => {
    expect(await runPosts(["skip"])).toBe(1);
  });

  it("requires --reason", async () => {
    expect(await runPosts(["skip", "p1"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("reason");
  });

  it("flips status to skipped + records post-skipped event", async () => {
    const code = await runPosts([
      "skip",
      "p1",
      "--reason",
      "off-brand after rereading",
    ]);
    expect(code).toBe(0);
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
      expect(updated?.status).toBe("skipped");
      expect(updated?.failureReason).toContain("off-brand");
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'post-skipped'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("returns 1 when row is not found", async () => {
    expect(
      await runPosts(["skip", "ghost", "--reason", "x"]),
    ).toBe(1);
  });
});
