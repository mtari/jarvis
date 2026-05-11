import path from "node:path";
import type { Brain } from "../../orchestrator/brain.ts";
import { getCached, setCached } from "./cache.ts";
import type { CompetitorSnapshot, CompetitorFetchOptions } from "./competitors.ts";
import { fetchCompetitorSnapshot } from "./competitors.ts";
import type { FacebookInsightsResult, FacebookInsightsOptions } from "./facebook-insights.ts";
import { fetchFacebookInsights } from "./facebook-insights.ts";
import type { TrendPoint, TrendTransport, TrendFetchOptions } from "./google-trends.ts";
import { fetchTrendSignals } from "./google-trends.ts";

export type { CompetitorSnapshot } from "./competitors.ts";
export type { FacebookInsightsResult } from "./facebook-insights.ts";
export type { TrendPoint } from "./google-trends.ts";

export interface ProjectResearchBundle {
  competitors: CompetitorSnapshot[];
  facebookInsights: FacebookInsightsResult | null;
  trends: TrendPoint[][] | null;
}

export interface GatherResearchOptions {
  fetchFn?: typeof globalThis.fetch;
  trendTransport?: TrendTransport;
  logger?: (msg: string) => void;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  // Test seams — replace individual adapters to control allSettled behavior
  competitorAdapter?: (url: string, opts?: CompetitorFetchOptions) => Promise<CompetitorSnapshot | null>;
  facebookAdapter?: (opts: FacebookInsightsOptions) => Promise<FacebookInsightsResult | null>;
  trendsAdapter?: (keywords: string[], opts?: TrendFetchOptions) => Promise<TrendPoint[][] | null>;
}

function narrowStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function resolveFacebookCreds(
  connections: Record<string, Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): { pageId: string; accessToken: string } | null {
  const fb = connections["facebook"];
  if (!fb || typeof fb !== "object") return null;

  const pageIdRaw = fb["pageId"];
  const tokenEnvRaw = fb["tokenEnvVar"];

  if (typeof pageIdRaw !== "string" || pageIdRaw.trim().length === 0) return null;
  if (typeof tokenEnvRaw !== "string" || tokenEnvRaw.trim().length === 0) return null;

  const accessToken = env[tokenEnvRaw];
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;

  return { pageId: pageIdRaw.trim(), accessToken: accessToken.trim() };
}

export async function gatherProjectResearch(
  brain: Brain,
  dataDir: string,
  opts: GatherResearchOptions = {},
): Promise<ProjectResearchBundle> {
  const {
    fetchFn,
    trendTransport,
    logger,
    nowMs,
    env = process.env,
    competitorAdapter = fetchCompetitorSnapshot,
    facebookAdapter = fetchFacebookInsights,
    trendsAdapter = fetchTrendSignals,
  } = opts;

  const cacheDir = path.join(dataDir, "research-cache", brain.projectName);
  const cacheOpts = nowMs !== undefined ? { nowMs } : {};

  const competitorUrls = narrowStringArray(brain.brand?.["competitors"]);
  const targetKeywords = narrowStringArray(brain.brand?.["targetKeywords"]);
  const fbCreds = resolveFacebookCreds(brain.connections, env);

  const competitorsTask = (async (): Promise<CompetitorSnapshot[]> => {
    if (competitorUrls.length === 0) return [];
    const cached = getCached<CompetitorSnapshot[]>(cacheDir, "competitors", cacheOpts);
    if (cached !== null) return cached;
    const snapshots = await Promise.all(
      competitorUrls.map((url) =>
        competitorAdapter(url, {
          ...(fetchFn !== undefined && { fetchFn }),
          ...(logger !== undefined && { logger }),
        }),
      ),
    );
    const result = snapshots.filter((s): s is CompetitorSnapshot => s !== null);
    setCached(cacheDir, "competitors", result, cacheOpts);
    return result;
  })();

  const facebookTask = (async (): Promise<FacebookInsightsResult | null> => {
    if (!fbCreds) return null;
    const cached = getCached<FacebookInsightsResult>(cacheDir, "facebook", cacheOpts);
    if (cached !== null) return cached;
    const result = await facebookAdapter({
      pageId: fbCreds.pageId,
      accessToken: fbCreds.accessToken,
      ...(fetchFn !== undefined && { fetchFn }),
    });
    if (result !== null) setCached(cacheDir, "facebook", result, cacheOpts);
    return result;
  })();

  const trendsTask = (async (): Promise<TrendPoint[][] | null> => {
    if (targetKeywords.length === 0) return null;
    const cached = getCached<TrendPoint[][]>(cacheDir, "trends", cacheOpts);
    if (cached !== null) return cached;
    const result = await trendsAdapter(targetKeywords, {
      ...(trendTransport !== undefined && { transport: trendTransport }),
    });
    if (result !== null) setCached(cacheDir, "trends", result, cacheOpts);
    return result;
  })();

  const [competitorsResult, facebookResult, trendsResult] = await Promise.allSettled([
    competitorsTask,
    facebookTask,
    trendsTask,
  ]);

  return {
    competitors:
      competitorsResult.status === "fulfilled" ? competitorsResult.value : [],
    facebookInsights:
      facebookResult.status === "fulfilled" ? facebookResult.value : null,
    trends:
      trendsResult.status === "fulfilled" ? trendsResult.value : null,
  };
}
