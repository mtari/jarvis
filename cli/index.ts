const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("jarvis — Phase 0 in progress. CLI commands land in M2.");
  console.log("See docs/MASTER_PLAN.md §17 for the planned surface.");
  process.exit(0);
}

console.log(`jarvis: command "${args[0]}" not implemented yet (Phase 0).`);
process.exit(1);
