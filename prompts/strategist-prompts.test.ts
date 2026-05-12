import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROMPTS_DIR = path.join(import.meta.dirname, ".");

const FIDELITY_SENTENCE =
  "When the user's brief contains identifiers that look similar but differ structurally (app slug like foo-bar vs domain like foo.bar), reproduce them exactly as given in the brief; never substitute one form for the other.";

const files = fs
  .readdirSync(PROMPTS_DIR)
  .filter((f) => f.startsWith("strategist-") && f.endsWith(".md"));

describe("strategist prompt identifier-fidelity rule", () => {
  for (const file of files) {
    it(`${file} contains the identifier-fidelity sentence`, () => {
      const content = fs.readFileSync(path.join(PROMPTS_DIR, file), "utf8");
      expect(content).toContain(FIDELITY_SENTENCE);
    });
  }
});
