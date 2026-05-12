import { describe, expect, it } from "vitest";
import { parseSlashArgs } from "./slash-args.ts";

describe("parseSlashArgs", () => {
  it("positional only — first token is app, rest is brief", () => {
    const result = parseSlashArgs("huntech-dev fix the nav bar");
    expect(result.parseError).toBeUndefined();
    expect(result.app).toBe("huntech-dev");
    expect(result.rest).toBe("fix the nav bar");
    expect(result.type).toBeUndefined();
  });

  it("--app flag then brief", () => {
    const result = parseSlashArgs('--app huntech-dev fix the nav bar');
    expect(result.parseError).toBeUndefined();
    expect(result.app).toBe("huntech-dev");
    expect(result.rest).toBe("fix the nav bar");
  });

  it("--type then --app then brief", () => {
    const result = parseSlashArgs("--type rework --app huntech-dev rework signup");
    expect(result.parseError).toBeUndefined();
    expect(result.app).toBe("huntech-dev");
    expect(result.type).toBe("rework");
    expect(result.rest).toBe("rework signup");
  });

  it("quoted brief with spaces is treated as a single token", () => {
    const result = parseSlashArgs('--app huntech-dev "fix nav bar"');
    expect(result.parseError).toBeUndefined();
    expect(result.app).toBe("huntech-dev");
    expect(result.rest).toBe("fix nav bar");
  });

  it("missing value after --app is a parse failure", () => {
    const result = parseSlashArgs("--app");
    expect(result.parseError).toMatch(/Missing value after --app/);
    expect(result.rest).toBe("");
    expect(result.app).toBeUndefined();
  });

  it("--app followed immediately by another flag is a parse failure", () => {
    const result = parseSlashArgs("--app --type rework");
    expect(result.parseError).toMatch(/Missing value after --app/);
  });

  it("original failing input from daemon log — resolves correctly", () => {
    // The exact invocation that triggered ENOENT on brains/--app/brain.json
    const result = parseSlashArgs('--app huntech-dev "fix the navbar"');
    expect(result.parseError).toBeUndefined();
    expect(result.app).toBe("huntech-dev");
    expect(result.rest).toBe("fix the navbar");
  });

  it("positional with no brief returns empty rest", () => {
    const result = parseSlashArgs("huntech-dev");
    expect(result.app).toBe("huntech-dev");
    expect(result.rest).toBe("");
    expect(result.parseError).toBeUndefined();
  });

  it("empty string returns undefined app and empty rest", () => {
    const result = parseSlashArgs("");
    expect(result.app).toBeUndefined();
    expect(result.rest).toBe("");
    expect(result.parseError).toBeUndefined();
  });
});
