import { parseArgs } from "node:util";
import { listPlans, type PlanRecord } from "../../orchestrator/plan-store.ts";
import {
  improvementSubtypeSchema,
  marketingSubtypeSchema,
  planStatusSchema,
  planTypeSchema,
  prioritySchema,
} from "../../orchestrator/plan.ts";
import { getDataDir } from "../paths.ts";

export async function runPlans(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        status: { type: "string" },
        type: { type: "string" },
        subtype: { type: "string" },
        priority: { type: "string" },
        executing: { type: "boolean" },
        approved: { type: "boolean" },
        "pending-review": { type: "boolean" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`plans: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  const validations: Array<{ key: string; value: string | undefined; allow: (s: string) => boolean }> = [
    { key: "status", value: v.status, allow: (s) => planStatusSchema.safeParse(s).success },
    { key: "type", value: v.type, allow: (s) => planTypeSchema.safeParse(s).success },
    { key: "priority", value: v.priority, allow: (s) => prioritySchema.safeParse(s).success },
    {
      key: "subtype",
      value: v.subtype,
      allow: (s) =>
        improvementSubtypeSchema.safeParse(s).success ||
        marketingSubtypeSchema.safeParse(s).success,
    },
  ];

  for (const { key, value, allow } of validations) {
    if (value && !allow(value)) {
      console.error(`plans: invalid --${key} "${value}"`);
      return 1;
    }
  }

  let statusFilter = v.status;
  if (v.executing) statusFilter = "executing";
  else if (v.approved) statusFilter = "approved";
  else if (v["pending-review"]) statusFilter = "awaiting-review";

  const dataDir = getDataDir();
  let records = listPlans(dataDir);

  if (v.app) records = records.filter((r) => r.app === v.app);
  if (statusFilter)
    records = records.filter((r) => r.plan.metadata.status === statusFilter);
  if (v.type) records = records.filter((r) => r.plan.metadata.type === v.type);
  if (v.subtype)
    records = records.filter((r) => r.plan.metadata.subtype === v.subtype);
  if (v.priority)
    records = records.filter((r) => r.plan.metadata.priority === v.priority);

  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(`plans: invalid --format "${format}" (expected table or json)`);
    return 1;
  }

  if (records.length === 0) {
    console.log("No plans match the filters.");
    return 0;
  }

  if (format === "json") {
    console.log(JSON.stringify(records.map(toJson), null, 2));
  } else {
    console.log(formatTable(records));
  }
  return 0;
}

function toJson(r: PlanRecord): Record<string, unknown> {
  return {
    id: r.id,
    vault: r.vault,
    app: r.app,
    type: r.plan.metadata.type,
    subtype: r.plan.metadata.subtype,
    priority: r.plan.metadata.priority,
    status: r.plan.metadata.status,
    title: r.plan.metadata.title,
  };
}

function formatTable(records: PlanRecord[]): string {
  const rows = records.map((r) => ({
    id: r.id,
    type: r.plan.metadata.subtype
      ? `${r.plan.metadata.type}/${r.plan.metadata.subtype}`
      : r.plan.metadata.type,
    app: r.app,
    status: r.plan.metadata.status,
    priority: r.plan.metadata.priority,
    title: r.plan.metadata.title,
  }));

  const headers: ReadonlyArray<keyof (typeof rows)[number]> = [
    "id",
    "type",
    "app",
    "status",
    "priority",
    "title",
  ];
  const labels: Record<(typeof headers)[number], string> = {
    id: "ID",
    type: "TYPE",
    app: "APP",
    status: "STATUS",
    priority: "PRIORITY",
    title: "TITLE",
  };

  const widths = headers.map((h) =>
    Math.max(labels[h].length, ...rows.map((r) => r[h].length)),
  );

  const formatRow = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  const lines: string[] = [];
  lines.push(formatRow(headers.map((h) => labels[h])));
  lines.push(formatRow(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    lines.push(formatRow(headers.map((h) => r[h])));
  }
  return lines.join("\n");
}
