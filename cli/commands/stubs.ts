// Stubs for commands that land in later Phase 0 milestones.
// Each prints what it'd do, names the milestone that delivers it,
// and exits non-zero so callers can detect the no-op.

interface Stub {
  message: string;
  milestone: string;
}

const STUBS: Record<string, Stub> = {
  doctor: {
    message: "doctor: liveness/lock/vault checks",
    milestone: "M2 follow-up",
  },
  inbox: {
    message: "inbox: pending plan reviews",
    milestone: "M2 follow-up",
  },
  plans: {
    message: "plans: list with filters",
    milestone: "M2 follow-up",
  },
  approve: {
    message: "approve: transition awaiting-review → approved",
    milestone: "M2 follow-up",
  },
  revise: {
    message: "revise: send plan back to draft with feedback",
    milestone: "M2 follow-up",
  },
  reject: {
    message: "reject: terminal rejection + suppression hook",
    milestone: "M2 follow-up",
  },
  plan: {
    message: "plan: Strategist drafts a new improvement plan",
    milestone: "M4 (Strategist agent)",
  },
  run: {
    message: "run: direct agent invocation",
    milestone: "M3 (Anthropic client wrapper) and beyond",
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
