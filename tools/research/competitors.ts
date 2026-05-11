export interface CompetitorSnapshot {
  url: string;
  title: string;
  h1: string;
  description: string;
  prices: string[];
}

export interface CompetitorFetchOptions {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  logger?: (msg: string) => void;
}

export async function fetchCompetitorSnapshot(
  url: string,
  opts: CompetitorFetchOptions = {},
): Promise<CompetitorSnapshot | null> {
  const { fetchFn = globalThis.fetch, timeoutMs = 10_000, logger } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  try {
    let response: Response;
    try {
      response = await fetchFn(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      logger?.(`fetchCompetitorSnapshot: non-2xx ${response.status} for ${url}`);
      return null;
    }
    html = await response.text();
  } catch (err) {
    logger?.(`fetchCompetitorSnapshot: error for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  try {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    const priceMatches = html.match(/[€$]\s?\d[\d.,]*|\b\d[\d.,]*\s?(HUF|EUR|USD)\b/gi);

    const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

    return {
      url,
      title: titleMatch ? stripTags(titleMatch[1] ?? "").trim() : "",
      h1: h1Match ? stripTags(h1Match[1] ?? "").trim() : "",
      description: descMatch ? (descMatch[1] ?? "").trim() : "",
      prices: priceMatches ?? [],
    };
  } catch (err) {
    logger?.(`fetchCompetitorSnapshot: parse error for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
