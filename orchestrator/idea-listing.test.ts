import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { businessIdeasFile, dbFile } from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { appendEvent } from "./event-log.ts";
import { formatIdeaListing, listIdeasWithStatus } from "./idea-listing.ts";

describe("listIdeasWithStatus", () => {
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

  it("returns an empty list when the file doesn't exist", () => {
    const rows = listIdeasWithStatus(sandbox.dataDir);
    expect(rows).toEqual([]);
  });

  it("sorts scored ideas high → low, then unscored alphabetically by title", () => {
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `## Beta unscored
App: a
Brief: b

## Alpha unscored
App: a
Brief: b

## Mid scored
App: a
Brief: b
Score: 50

## High scored
App: a
Brief: b
Score: 90

`,
    );

    const rows = listIdeasWithStatus(sandbox.dataDir);
    expect(rows.map((r) => r.idea.title)).toEqual([
      "High scored",
      "Mid scored",
      "Alpha unscored",
      "Beta unscored",
    ]);
  });

  it("marks ideas that have an idea-drafted event", () => {
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `## My idea
App: erdei-fahazak
Brief: do something
Score: 85

## Other idea
App: erdei-fahazak
Brief: also do something
Score: 80

`,
    );
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "erdei-fahazak",
        vaultId: "personal",
        kind: "idea-drafted",
        payload: { ideaId: "my-idea" },
      });
    } finally {
      db.close();
    }

    const rows = listIdeasWithStatus(sandbox.dataDir);
    const my = rows.find((r) => r.idea.id === "my-idea");
    const other = rows.find((r) => r.idea.id === "other-idea");
    expect(my?.drafted).toBe(true);
    expect(other?.drafted).toBe(false);
  });
});

describe("formatIdeaListing", () => {
  it("returns an empty-state hint when there are no ideas", () => {
    const plain = formatIdeaListing([], "plain");
    expect(plain).toContain("No ideas yet");
    expect(plain).toContain("yarn jarvis ideas add");

    const slack = formatIdeaListing([], "slack");
    expect(slack).toContain("No ideas yet");
    expect(slack).toContain("/jarvis ideas add");
  });

  it("renders score, title, app, tags, brief, rationale", () => {
    const text = formatIdeaListing(
      [
        {
          idea: {
            id: "x",
            title: "Personal-brand newsletter",
            app: "new",
            brief: "Weekly behind-the-scenes letter.",
            tags: ["brand", "content"],
            score: 85,
            rationale: "Clear strategic fit, low effort.",
            body: "",
          },
          drafted: true,
        },
      ],
      "plain",
    );
    expect(text).toContain("[ 85]");
    expect(text).toContain("Personal-brand newsletter");
    expect(text).toContain("→ new");
    expect(text).toContain("✓drafted");
    expect(text).toContain("#brand #content");
    expect(text).toContain("Weekly behind-the-scenes letter.");
    expect(text).toContain("Why: Clear strategic fit, low effort.");
  });

  it("uses Slack mrkdwn when markup=slack", () => {
    const text = formatIdeaListing(
      [
        {
          idea: {
            id: "x",
            title: "Foo",
            app: "erdei-fahazak",
            brief: "bar",
            tags: [],
            body: "",
          },
          drafted: false,
        },
      ],
      "slack",
    );
    expect(text).toContain("*Foo*");
    expect(text).toContain("`erdei-fahazak`");
    expect(text).toContain("[ — ]"); // unscored placeholder
  });
});
