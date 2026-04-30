import { describe, expect, it } from "vitest";
import yarnAuditCollector, {
  advisoryToSignal,
  extractAdvisory,
} from "./yarn-audit.ts";

describe("extractAdvisory", () => {
  it("returns null for non-objects", () => {
    expect(extractAdvisory("hello")).toBeNull();
    expect(extractAdvisory(null)).toBeNull();
    expect(extractAdvisory(42)).toBeNull();
  });

  it("returns null for envelopes without auditAdvisory type", () => {
    expect(extractAdvisory({ type: "auditSummary", data: {} })).toBeNull();
    expect(extractAdvisory({ data: { advisory: { title: "x" } } })).toBeNull();
  });

  it("returns the advisory body when the envelope is well-formed", () => {
    const adv = {
      module_name: "lodash",
      severity: "high",
      title: "Prototype pollution",
      url: "https://example/advisory/1",
      cves: ["CVE-2026-0001"],
    };
    const out = extractAdvisory({ type: "auditAdvisory", data: { advisory: adv } });
    expect(out).toEqual(adv);
  });

  it("returns null when the advisory is missing a title", () => {
    expect(
      extractAdvisory({
        type: "auditAdvisory",
        data: { advisory: { module_name: "x" } },
      }),
    ).toBeNull();
  });
});

describe("advisoryToSignal", () => {
  it("maps npm severities to SignalSeverity", () => {
    const cases: Array<[string, string]> = [
      ["critical", "critical"],
      ["high", "high"],
      ["moderate", "medium"],
      ["medium", "medium"],
      ["low", "low"],
      ["info", "low"],
      ["unknown", "low"],
    ];
    for (const [npm, expected] of cases) {
      const s = advisoryToSignal({
        module_name: "x",
        severity: npm,
        title: "t",
      });
      expect(s.severity).toBe(expected);
    }
  });

  it("uses CVE for dedupKey when present", () => {
    const s = advisoryToSignal({
      module_name: "lodash",
      severity: "high",
      title: "Proto",
      cves: ["CVE-2026-0001"],
    });
    expect(s.dedupKey).toBe("yarn-audit:CVE-2026-0001");
  });

  it("falls back to module+title when CVE is missing", () => {
    const s = advisoryToSignal({
      module_name: "lodash",
      severity: "moderate",
      title: "Some issue",
    });
    expect(s.dedupKey).toBe("yarn-audit:lodash:Some issue");
  });

  it("includes structured details", () => {
    const s = advisoryToSignal({
      module_name: "lodash",
      severity: "high",
      title: "Proto",
      url: "https://example/a/1",
      cves: ["CVE-X"],
      vulnerable_versions: "<4.17.21",
      patched_versions: ">=4.17.21",
    });
    expect(s.details).toMatchObject({
      module: "lodash",
      severity: "high",
      title: "Proto",
      url: "https://example/a/1",
      cves: ["CVE-X"],
      vulnerable: "<4.17.21",
      patched: ">=4.17.21",
    });
  });

  it("summary is short and includes module + severity + title", () => {
    const s = advisoryToSignal({
      module_name: "lodash",
      severity: "high",
      title: "Prototype pollution",
    });
    expect(s.summary).toContain("lodash");
    expect(s.summary).toContain("high");
    expect(s.summary).toContain("Prototype pollution");
  });
});

describe("yarnAuditCollector — collect()", () => {
  it("exposes the expected kind and description", () => {
    expect(yarnAuditCollector.kind).toBe("yarn-audit");
    expect(yarnAuditCollector.description).toMatch(/yarn audit/i);
  });
});
