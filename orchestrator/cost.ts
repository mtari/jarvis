// Per-model pricing in USD per 1M tokens, current as of January 2026.
// When Anthropic publishes new prices, update here — the cost command
// reads from this table.

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
  cacheCreationPerMTok: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic claude-sonnet-4-6
  "claude-sonnet-4-6": {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cachedInputPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
  },
  // Anthropic claude-haiku-4-5
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cachedInputPerMTok: 0.1,
    cacheCreationPerMTok: 1.25,
  },
  // Anthropic claude-opus-4-7
  "claude-opus-4-7": {
    inputPerMTok: 15.0,
    outputPerMTok: 75.0,
    cachedInputPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
  },
};

const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-sonnet-4-6"]!;

export interface CallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

/** Returns the pricing entry for the model, falling back to Sonnet 4.6 when unknown. */
export function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

/** Returns true if we have explicit pricing for the model (false → using fallback). */
export function hasExplicitPricing(model: string): boolean {
  return model in MODEL_PRICING;
}

/** Total dollar cost of a single API call. */
export function costForCall(usage: CallUsage): number {
  const p = pricingFor(usage.model);
  return (
    (usage.inputTokens / 1_000_000) * p.inputPerMTok +
    (usage.outputTokens / 1_000_000) * p.outputPerMTok +
    (usage.cachedInputTokens / 1_000_000) * p.cachedInputPerMTok +
    (usage.cacheCreationTokens / 1_000_000) * p.cacheCreationPerMTok
  );
}

export function formatUsd(amount: number): string {
  if (amount < 0.005) return "$0.00";
  return `$${amount.toFixed(2)}`;
}

/** Returns the share of total input tokens that hit the prompt cache (0..1). */
export function cacheHitRate(
  usages: ReadonlyArray<Pick<CallUsage, "inputTokens" | "cachedInputTokens">>,
): number {
  let billable = 0;
  let cached = 0;
  for (const u of usages) {
    billable += u.inputTokens + u.cachedInputTokens;
    cached += u.cachedInputTokens;
  }
  if (billable === 0) return 0;
  return cached / billable;
}
