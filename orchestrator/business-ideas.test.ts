import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { businessIdeasFile } from "../cli/paths.ts";
import {
  formatBusinessIdeas,
  IdeaSectionParseError,
  loadBusinessIdeas,
  parseBusinessIdeas,
  parseIdeaSection,
  saveBusinessIdeas,
} from "./business-ideas.ts";

// ---------------------------------------------------------------------------
// parseBusinessIdeas — pure parsing
// ---------------------------------------------------------------------------

describe("parseBusinessIdeas", () => {
  it("returns empty result for empty input", () => {
    expect(parseBusinessIdeas("")).toEqual({
      ideas: [],
      unparseable: [],
      preamble: "",
    });
  });

  it("returns empty when only a preamble is present (no `## ` sections)", () => {
    const md = `# Business Ideas\n\nA running list. Add ideas below.\n`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas).toEqual([]);
    expect(result.unparseable).toEqual([]);
    // preamble preserved
    expect(result.preamble).toContain("A running list");
  });

  it("parses a single idea with the required fields", () => {
    const md = `# Business Ideas

## Shorten checkout funnel
App: erdei-fahazak
Brief: Address-step drop-off is high; try inline validation.
`;
    const result = parseBusinessIdeas(md);
    expect(result.unparseable).toEqual([]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]).toMatchObject({
      id: "shorten-checkout-funnel",
      title: "Shorten checkout funnel",
      app: "erdei-fahazak",
      brief: "Address-step drop-off is high; try inline validation.",
      tags: [],
      body: "",
    });
    expect(result.ideas[0]?.score).toBeUndefined();
  });

  it("parses tags as a comma-separated list", () => {
    const md = `## Idea
App: x
Brief: y
Tags: conversion, frontend , marketing
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.tags).toEqual(["conversion", "frontend", "marketing"]);
  });

  it("treats trailing-comma / empty tag entries as no-ops", () => {
    const md = `## Idea
App: x
Brief: y
Tags: a,, b ,
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.tags).toEqual(["a", "b"]);
  });

  it("parses Scout-written fields when present (Score, ScoredAt, Rationale)", () => {
    const md = `## Idea
App: jarvis
Brief: y
Score: 72
ScoredAt: 2026-04-30T09:00:00Z
Rationale: Quick to ship; high signal from existing data.
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.score).toBe(72);
    expect(idea?.scoredAt).toBe("2026-04-30T09:00:00Z");
    expect(idea?.rationale).toBe(
      "Quick to ship; high signal from existing data.",
    );
  });

  it("treats meta keys case-insensitively", () => {
    const md = `## Idea
APP: jarvis
brief: y
TAGS: a, b
score: 50
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.app).toBe("jarvis");
    expect(idea?.brief).toBe("y");
    expect(idea?.tags).toEqual(["a", "b"]);
    expect(idea?.score).toBe(50);
  });

  it("captures the body — content after the first blank line", () => {
    const md = `## Idea
App: x
Brief: y

This is the body. It can have multiple paragraphs.

Even with stuff like Key: value that looks like meta — it stays in the body.
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.body).toBe(
      "This is the body. It can have multiple paragraphs.\n\nEven with stuff like Key: value that looks like meta — it stays in the body.",
    );
  });

  it("parses multiple sections in document order", () => {
    const md = `# Business Ideas

## First idea
App: jarvis
Brief: a

## Second idea
App: erdei-fahazak
Brief: b

## Third idea
App: new
Brief: c
`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas.map((i) => i.title)).toEqual([
      "First idea",
      "Second idea",
      "Third idea",
    ]);
  });

  it("disambiguates duplicate titles with `-2`, `-3` id suffixes", () => {
    const md = `## Idea
App: a
Brief: x

## Idea
App: b
Brief: y

## Idea
App: c
Brief: z
`;
    const ids = parseBusinessIdeas(md).ideas.map((i) => i.id);
    expect(ids).toEqual(["idea", "idea-2", "idea-3"]);
  });

  it("flags sections missing required fields without crashing", () => {
    const md = `## Missing app
Brief: y

## Missing brief
App: x

## Good one
App: z
Brief: w
`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas.map((i) => i.title)).toEqual(["Good one"]);
    expect(result.unparseable).toEqual([
      { heading: "Missing app", reason: "missing required field: App" },
      { heading: "Missing brief", reason: "missing required field: Brief" },
    ]);
  });

  it("flags an out-of-range Score as unparseable", () => {
    const md = `## Idea
App: x
Brief: y
Score: 150
`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas).toHaveLength(0);
    expect(result.unparseable[0]?.reason).toContain("Score must be an integer");
  });

  it("flags a non-numeric Score as unparseable", () => {
    const md = `## Idea
App: x
Brief: y
Score: not-a-number
`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas).toHaveLength(0);
    expect(result.unparseable[0]?.reason).toContain("Score must be an integer");
  });

  it("ignores unknown meta keys (forward-compat)", () => {
    const md = `## Idea
App: x
Brief: y
FutureField: whatever
`;
    const result = parseBusinessIdeas(md);
    expect(result.ideas).toHaveLength(1);
    expect(result.unparseable).toHaveLength(0);
  });

  it("slugifies titles with punctuation + diacritics", () => {
    const md = `## Add "magic links" — passwordless v2!
App: x
Brief: y
`;
    const [idea] = parseBusinessIdeas(md).ideas;
    expect(idea?.id).toBe("add-magic-links-passwordless-v2");
  });
});

// ---------------------------------------------------------------------------
// loadBusinessIdeas — file integration
// ---------------------------------------------------------------------------

describe("loadBusinessIdeas", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bi-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty when Business_Ideas.md doesn't exist", () => {
    expect(loadBusinessIdeas(dataDir)).toEqual({
      ideas: [],
      unparseable: [],
      preamble: "",
    });
  });

  it("reads + parses the file when present", () => {
    fs.writeFileSync(
      businessIdeasFile(dataDir),
      `## Idea\nApp: x\nBrief: y\n`,
    );
    const result = loadBusinessIdeas(dataDir);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.app).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// formatBusinessIdeas / saveBusinessIdeas — writer + round-trip
// ---------------------------------------------------------------------------

describe("formatBusinessIdeas", () => {
  it("emits the meta block in the canonical order", () => {
    const md = formatBusinessIdeas({
      preamble: "",
      unparseable: [],
      ideas: [
        {
          id: "x",
          title: "X",
          app: "demo",
          brief: "do the thing",
          tags: ["a", "b"],
          score: 50,
          scoredAt: "2026-05-05T00:00:00Z",
          rationale: "because reasons",
          body: "",
        },
      ],
    });
    expect(md).toBe(
      [
        "## X",
        "App: demo",
        "Brief: do the thing",
        "Tags: a, b",
        "Score: 50",
        "ScoredAt: 2026-05-05T00:00:00Z",
        "Rationale: because reasons",
        "",
      ].join("\n") + "\n",
    );
  });

  it("omits optional fields cleanly", () => {
    const md = formatBusinessIdeas({
      preamble: "",
      unparseable: [],
      ideas: [
        {
          id: "min",
          title: "Min",
          app: "demo",
          brief: "tiny",
          tags: [],
          body: "",
        },
      ],
    });
    expect(md).not.toContain("Tags:");
    expect(md).not.toContain("Score:");
    expect(md).not.toContain("Rationale:");
    expect(md).toContain("App: demo");
    expect(md).toContain("Brief: tiny");
  });

  it("preserves the body section", () => {
    const md = formatBusinessIdeas({
      preamble: "",
      unparseable: [],
      ideas: [
        {
          id: "x",
          title: "X",
          app: "demo",
          brief: "y",
          tags: [],
          body: "Multi-line\nbody prose here.",
        },
      ],
    });
    expect(md).toContain("Brief: y\n\nMulti-line\nbody prose here.\n");
  });

  it("preserves the preamble verbatim", () => {
    const md = formatBusinessIdeas({
      preamble:
        "# Business Ideas\n\nA running list of unbuilt ideas. Add yours below.",
      unparseable: [],
      ideas: [],
    });
    expect(md.startsWith("# Business Ideas\n\nA running list")).toBe(true);
  });

  it("round-trips a parsed file (parse -> format -> parse) without losing data", () => {
    const original = `# Business Ideas

Some preamble text.

## Shorten checkout funnel
App: demo
Brief: address-step drop-off
Tags: conversion, frontend
Score: 72
ScoredAt: 2026-04-30T09:00:00Z
Rationale: high signal; quick to ship

The address step has been the #1 drop-off for two months running.
Hypothesis: users abandon when validation errors appear after submit.

## Newsletter
App: new
Brief: weekly portfolio digest
`;
    const parsed = parseBusinessIdeas(original);
    const reformatted = formatBusinessIdeas(parsed);
    const reparsed = parseBusinessIdeas(reformatted);
    expect(reparsed.ideas).toEqual(parsed.ideas);
    expect(reparsed.preamble).toBe(parsed.preamble);
  });
});

// ---------------------------------------------------------------------------
// parseIdeaSection — single-section parser
// ---------------------------------------------------------------------------

describe("parseIdeaSection", () => {
  it("returns a BusinessIdea for a well-formed single section", () => {
    const text = `## My Idea\nApp: demo\nBrief: do the thing\n`;
    const idea = parseIdeaSection(text);
    expect(idea.title).toBe("My Idea");
    expect(idea.app).toBe("demo");
    expect(idea.brief).toBe("do the thing");
    expect(idea.id).toBe("my-idea");
  });

  it("throws IdeaSectionParseError when the heading is empty (## with no title)", () => {
    const text = `## \nApp: demo\nBrief: y\n`;
    expect(() => parseIdeaSection(text)).toThrow(IdeaSectionParseError);
  });
});

describe("saveBusinessIdeas", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bi-write-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates the file and writes the formatted content", () => {
    saveBusinessIdeas(dataDir, {
      preamble: "# Business Ideas\n",
      unparseable: [],
      ideas: [
        {
          id: "x",
          title: "X",
          app: "demo",
          brief: "y",
          tags: [],
          body: "",
        },
      ],
    });
    const reloaded = loadBusinessIdeas(dataDir);
    expect(reloaded.ideas).toHaveLength(1);
    expect(reloaded.ideas[0]?.title).toBe("X");
    expect(reloaded.preamble).toContain("# Business Ideas");
  });

  it("supports merge-then-save: read, mutate one idea, write back", () => {
    const initial = `# Business Ideas

## Shorten checkout funnel
App: demo
Brief: y
`;
    fs.writeFileSync(`${dataDir}/Business_Ideas.md`, initial);
    const file = loadBusinessIdeas(dataDir);
    const idea = file.ideas[0]!;
    file.ideas[0] = {
      ...idea,
      score: 88,
      scoredAt: "2026-05-05T08:00:00Z",
      rationale: "high impact, low effort",
    };
    saveBusinessIdeas(dataDir, file);

    const reloaded = loadBusinessIdeas(dataDir);
    expect(reloaded.ideas[0]?.score).toBe(88);
    expect(reloaded.ideas[0]?.rationale).toBe("high impact, low effort");
  });
});
