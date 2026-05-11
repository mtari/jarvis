export interface FacebookInsightsResult {
  pageImpressions: number;
  pageEngagedUsers: number;
  pagePostEngagements: number;
}

export interface FacebookInsightsOptions {
  pageId: string;
  accessToken: string;
  fetchFn?: typeof globalThis.fetch;
  graphApiVersion?: string;
  timeoutMs?: number;
}

interface MetricValue {
  value: number;
  end_time?: string;
}

interface MetricEntry {
  name: string;
  values: MetricValue[];
}

interface InsightsResponse {
  data: MetricEntry[];
}

export async function fetchFacebookInsights(
  opts: FacebookInsightsOptions,
): Promise<FacebookInsightsResult | null> {
  const {
    pageId,
    accessToken,
    fetchFn = globalThis.fetch,
    graphApiVersion = "v19.0",
    timeoutMs = 30_000,
  } = opts;

  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString().split("T")[0]!;

  const params = new URLSearchParams({
    metric: "page_impressions,page_engaged_users,page_post_engagements",
    period: "day",
    since: sinceIso,
    access_token: accessToken,
  });
  const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(pageId)}/insights?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return null;
  }

  let json: InsightsResponse;
  try {
    json = (await response.json()) as InsightsResponse;
  } catch {
    return null;
  }

  const sumMetric = (name: string): number => {
    const entry = json.data.find((m) => m.name === name);
    if (!entry) return 0;
    return entry.values.reduce((acc, v) => acc + (v.value ?? 0), 0);
  };

  return {
    pageImpressions: sumMetric("page_impressions"),
    pageEngagedUsers: sumMetric("page_engaged_users"),
    pagePostEngagements: sumMetric("page_post_engagements"),
  };
}
