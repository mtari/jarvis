import { parseArgs } from "node:util";
import {
  listPlans,
  type PlanRecord,
} from "../../orchestrator/plan-store.ts";
import { getDataDir } from "../paths.ts";

const PRIORITY_RANK: Record<string, number> = {
  blocking: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const PRODUCT_BACKLOG_TARGET = 3;

const BACKLOG_STATES: ReadonlySet<string> = new Set([
  "awaiting-review",
  "approved",
]);

export async function runBacklog(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        "meta-only": { type: "boolean" },
        "no-meta": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`backlog: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  if (!v.app) {
    console.error(
      "backlog: --app is required. Usage: yarn jarvis backlog --app <name>",
    );
    return 1;
  }
  if (v["meta-only"] && v["no-meta"]) {
    console.error(
      "backlog: --meta-only and --no-meta are mutually exclusive.",
    );
    return 1;
  }

  const app = v.app;
  const dataDir = getDataDir();
  const records = listPlans(dataDir).filter(
    (p) =>
      p.app === app &&
      p.plan.metadata.type === "improvement" &&
      BACKLOG_STATES.has(p.plan.metadata.status),
  );

  const product = records.filter((p) => p.plan.metadata.subtype !== "meta");
  const meta = records.filter((p) => p.plan.metadata.subtype === "meta");
  product.sort(comparePlans);
  meta.sort(comparePlans);

  const sections: string[] = [];
  if (!v["meta-only"]) sections.push(formatProductBacklog(app, product));
  if (!v["no-meta"]) sections.push(formatMetaQueue(app, meta));

  console.log(sections.join("\n\n"));
  return 0;
}

function comparePlans(a: PlanRecord, b: PlanRecord): number {
  const rankA = PRIORITY_RANK[a.plan.metadata.priority] ?? 99;
  const rankB = PRIORITY_RANK[b.plan.metadata.priority] ?? 99;
  if (rankA !== rankB) return rankA - rankB;
  return a.id.localeCompare(b.id);
}

function formatRow(p: PlanRecord, index: number | null): string {
  const subtype = p.plan.metadata.subtype ?? "—";
  const prefix =
    index !== null ? `  ${(index + 1).toString().padStart(2, " ")}. ` : "  - ";
  return `${prefix}${p.id}  [${subtype}]  [${p.plan.metadata.priority}]  [${p.plan.metadata.status}]  ${p.plan.metadata.title}`;
}

function formatProductBacklog(app: string, plans: PlanRecord[]): string {
  const count = plans.length;
  let header: string;
  if (count === 0) {
    header = `Product backlog for ${app} (0/${PRODUCT_BACKLOG_TARGET}, ${PRODUCT_BACKLOG_TARGET} slots open):`;
    return `${header}\n  (empty)`;
  }
  if (count > PRODUCT_BACKLOG_TARGET) {
    header = `Product backlog for ${app} (${count}/${PRODUCT_BACKLOG_TARGET}, ⚠ ${count - PRODUCT_BACKLOG_TARGET} over cap):`;
  } else if (count < PRODUCT_BACKLOG_TARGET) {
    header = `Product backlog for ${app} (${count}/${PRODUCT_BACKLOG_TARGET}, ${PRODUCT_BACKLOG_TARGET - count} slots open):`;
  } else {
    header = `Product backlog for ${app} (${count}/${PRODUCT_BACKLOG_TARGET}):`;
  }
  const rows = plans.map((p, i) => formatRow(p, i));
  return [header, ...rows].join("\n");
}

function formatMetaQueue(app: string, plans: PlanRecord[]): string {
  if (plans.length === 0) {
    return `Meta queue for ${app}: (empty)`;
  }
  const header = `Meta queue for ${app} (${plans.length}, uncapped):`;
  const rows = plans.map((p) => formatRow(p, null));
  return [header, ...rows].join("\n");
}
