import fs from "node:fs";
import { listPlans } from "../../orchestrator/plan-store.ts";
import { getDataDir, setupQueueFile } from "../paths.ts";

export async function runInbox(_rawArgs: string[]): Promise<number> {
  const dataDir = getDataDir();
  const plans = listPlans(dataDir);
  const pending = plans.filter(
    (p) => p.plan.metadata.status === "awaiting-review",
  );

  let setupCount = 0;
  const setupPath = setupQueueFile(dataDir);
  if (fs.existsSync(setupPath)) {
    setupCount = fs
      .readFileSync(setupPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
  }

  if (pending.length === 0 && setupCount === 0) {
    console.log("Inbox is empty.");
    return 0;
  }

  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(`Pending plan reviews (${pending.length}):`);
    for (const p of pending) {
      const subtype = p.plan.metadata.subtype
        ? `/${p.plan.metadata.subtype}`
        : "";
      lines.push(
        `  ${p.id}  [${p.plan.metadata.type}${subtype}]  [${p.plan.metadata.priority}]  ${p.plan.metadata.title}`,
      );
    }
  }

  if (setupCount > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Pending setup tasks (${setupCount}):`);
    lines.push(`  See ${setupPath}`);
  }

  console.log(lines.join("\n"));
  return 0;
}
