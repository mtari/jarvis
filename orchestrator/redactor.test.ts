import { describe, expect, it } from "vitest";
import { hasSecrets, redact, REDACTION_PLACEHOLDER } from "./redactor.ts";

// All "key" fixtures below are synthetic — built from concatenated literal
// fragments so the source bytes never contain a contiguous real-key shape.
// The runtime values still match the redactor's regexes; the pieces are
// just split at safe boundaries to keep GitHub's push-protection scanner
// from flagging the test file as a leaked secret.
const ANTHROPIC = "sk-" + "ant-" + "api03-" + "A".repeat(40) + "_suffix";
const OPENAI = "sk-" + "A".repeat(48);
const GH_PAT = "ghp_" + "B".repeat(36);
const GH_FINE = "github" + "_pat_" + "C".repeat(82);
const AWS = "AKIA" + "Z".repeat(16);
const STRIPE_LIVE = "sk" + "_live_" + "D".repeat(30);
const STRIPE_TEST = "sk" + "_test_" + "E".repeat(30);
const DOPPLER = "dp" + ".st." + "dev." + "F".repeat(40);
const JWT_HEAD = "eyJ" + "hbGciOiJIUzI1NiJ9";
const JWT_BODY = "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ";
const JWT_SIG = "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";
const JWT = JWT_HEAD + "." + JWT_BODY + "." + JWT_SIG;

describe("redact", () => {
  it("returns input unchanged when no secrets are present", () => {
    const text = "hello world, no secrets here";
    expect(redact(text)).toEqual({ text, matches: [] });
  });

  it("redacts an Anthropic API key", () => {
    const result = redact(`API key: ${ANTHROPIC}`);
    expect(result.text).toBe(`API key: ${REDACTION_PLACEHOLDER}`);
    expect(result.matches[0]?.kind).toBe("anthropic-key");
  });

  it("redacts an OpenAI sk- key", () => {
    const result = redact(`OpenAI: ${OPENAI}`);
    expect(result.text).toBe(`OpenAI: ${REDACTION_PLACEHOLDER}`);
    expect(result.matches[0]?.kind).toBe("openai-key");
  });

  it("redacts a GitHub PAT", () => {
    const result = redact(`token = ${GH_PAT}`);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.matches.some((m) => m.kind === "github-token")).toBe(true);
  });

  it("redacts a GitHub fine-grained PAT", () => {
    const result = redact(`token = ${GH_FINE}`);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.matches.some((m) => m.kind === "github-pat")).toBe(true);
  });

  it("redacts an AWS access key", () => {
    const result = redact(`aws: ${AWS}`);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.matches[0]?.kind).toBe("aws-access-key");
  });

  it("redacts Stripe live and test keys", () => {
    const result = redact(`live=${STRIPE_LIVE} test=${STRIPE_TEST}`);
    expect(result.matches.filter((m) => m.kind === "stripe-key")).toHaveLength(
      2,
    );
  });

  it("redacts a Doppler service token", () => {
    const result = redact(`tok = ${DOPPLER}`);
    expect(result.matches.some((m) => m.kind === "doppler-token")).toBe(true);
  });

  it("redacts a JWT", () => {
    const result = redact(`Authorization: Bearer ${JWT}`);
    expect(result.matches.some((m) => m.kind === "jwt")).toBe(true);
  });

  it("redacts a .env-style assignment", () => {
    const result = redact(`STRIPE_SECRET_KEY=${STRIPE_LIVE}`);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.text).not.toContain("STRIPE_SECRET_KEY");
    expect(result.matches[0]?.kind).toBe("env-secret");
  });

  it("does not redact a plain word like AKIA without enough chars", () => {
    const result = redact("docs reference AKIA in a sentence");
    expect(result.matches).toEqual([]);
  });

  it("redacts multiple secrets in one input", () => {
    const result = redact(`Two: ${GH_PAT} and ${AWS}.`);
    expect(result.matches).toHaveLength(2);
    expect(result.text).toBe(
      `Two: ${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}.`,
    );
  });

  it("collapses overlapping patterns into a single redaction span", () => {
    const result = redact(`STRIPE_SECRET_KEY=${STRIPE_LIVE}`);
    expect(result.matches).toHaveLength(1);
    expect(result.text).toBe(REDACTION_PLACEHOLDER);
  });

  it("preserves whitespace and surrounding text exactly", () => {
    const result = redact(`  prefix\n\t${GH_PAT}\n  suffix`);
    expect(result.text).toBe(
      `  prefix\n\t${REDACTION_PLACEHOLDER}\n  suffix`,
    );
  });

  it("never echoes the secret in the matches array", () => {
    const result = redact(`token = ${GH_PAT}`);
    const json = JSON.stringify(result.matches);
    expect(json).not.toContain(GH_PAT);
    expect(json).not.toContain("ghp_");
  });
});

describe("hasSecrets", () => {
  it("returns false when no secrets are present", () => {
    expect(hasSecrets("nothing to see")).toBe(false);
  });

  it("returns true when a secret is present", () => {
    expect(hasSecrets(`token = ${GH_PAT}`)).toBe(true);
  });
});
