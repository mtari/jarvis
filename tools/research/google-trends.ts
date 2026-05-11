export interface TrendPoint {
  date: string;
  value: number;
}

export interface TrendTransport {
  interestOverTime(opts: {
    keyword: string;
    startTime: Date;
    geo?: string;
  }): Promise<string>;
}

interface TimelineDataEntry {
  formattedAxisTime: string;
  value: number[];
}

interface TrendsResponse {
  default: {
    timelineData: TimelineDataEntry[];
  };
}

export interface TrendFetchOptions {
  transport?: TrendTransport;
  geo?: string;
  now?: Date;
}

export async function fetchTrendSignals(
  keywords: string[],
  opts: TrendFetchOptions = {},
): Promise<TrendPoint[][] | null> {
  if (keywords.length === 0) return null;

  let transport = opts.transport;
  if (!transport) {
    const mod = await import("google-trends-api");
    transport = mod.default as TrendTransport;
  }

  const now = opts.now ?? new Date();
  const startTime = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const geo = opts.geo;

  const results: TrendPoint[][] = [];
  let allFailed = true;

  for (const keyword of keywords) {
    try {
      const raw = await transport.interestOverTime({
        keyword,
        startTime,
        ...(geo !== undefined && { geo }),
      });
      const parsed = JSON.parse(raw) as TrendsResponse;
      const points: TrendPoint[] = parsed.default.timelineData.map((entry) => ({
        date: entry.formattedAxisTime,
        value: entry.value[0] ?? 0,
      }));
      results.push(points);
      allFailed = false;
    } catch {
      results.push([]);
    }
  }

  if (allFailed) return null;
  return results;
}
