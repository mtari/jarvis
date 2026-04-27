// Stubs for commands that land in later Phase 0 milestones.
// Each prints what it'd do, names the milestone that delivers it,
// and exits non-zero so callers can detect the no-op.

interface Stub {
  message: string;
  milestone: string;
}

const STUBS: Record<string, Stub> = {
  run: {
    message: "run: direct agent invocation",
    milestone: "M5 (Developer agent) and beyond",
  },
};

export async function runStub(commandName: string): Promise<number> {
  const stub = STUBS[commandName];
  if (!stub) {
    console.error(`No stub registered for ${commandName}`);
    return 1;
  }
  console.log(
    `${stub.message} — not implemented yet. Lands in ${stub.milestone}.`,
  );
  return 1;
}
