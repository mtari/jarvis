import { describe, expect, it } from "vitest";
import {
  ChannelResolveError,
  resolveChannels,
} from "./channel-resolver.ts";

interface FakeChannel {
  id: string;
  name: string;
}

interface FakeListResponse {
  ok: boolean;
  channels?: FakeChannel[];
  error?: string;
  response_metadata?: { next_cursor?: string };
}

function makeFakeWebClient(pages: FakeListResponse[]): {
  client: {
    conversations: {
      list: (opts: { cursor?: string; types?: string }) => Promise<FakeListResponse>;
    };
  };
  pageCalls: Array<{ cursor?: string }>;
} {
  const pageCalls: Array<{ cursor?: string }> = [];
  let i = 0;
  return {
    pageCalls,
    client: {
      conversations: {
        async list(opts) {
          pageCalls.push({ ...(opts.cursor !== undefined && { cursor: opts.cursor }) });
          return pages[i++] ?? { ok: true, channels: [] };
        },
      },
    },
  };
}

describe("resolveChannels", () => {
  it("finds channels by name and strips leading hash", async () => {
    const { client } = makeFakeWebClient([
      {
        ok: true,
        channels: [
          { id: "C001", name: "general" },
          { id: "C002", name: "jarvis-inbox" },
          { id: "C003", name: "jarvis-alerts" },
        ],
      },
    ]);
    const result = await resolveChannels(client as never, {
      inboxName: "#jarvis-inbox",
      alertsName: "#jarvis-alerts",
    });
    expect(result).toEqual({ inbox: "C002", alerts: "C003" });
  });

  it("throws ChannelResolveError when the inbox channel isn't found", async () => {
    const { client } = makeFakeWebClient([
      {
        ok: true,
        channels: [{ id: "C003", name: "jarvis-alerts" }],
      },
    ]);
    await expect(
      resolveChannels(client as never, {
        inboxName: "jarvis-inbox",
        alertsName: "jarvis-alerts",
      }),
    ).rejects.toBeInstanceOf(ChannelResolveError);
  });

  it("paginates via response_metadata.next_cursor", async () => {
    const { client, pageCalls } = makeFakeWebClient([
      {
        ok: true,
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "page2" },
      },
      {
        ok: true,
        channels: [
          { id: "C002", name: "jarvis-inbox" },
          { id: "C003", name: "jarvis-alerts" },
        ],
      },
    ]);
    const result = await resolveChannels(client as never, {
      inboxName: "jarvis-inbox",
      alertsName: "jarvis-alerts",
    });
    expect(result).toEqual({ inbox: "C002", alerts: "C003" });
    expect(pageCalls).toHaveLength(2);
    expect(pageCalls[1]?.cursor).toBe("page2");
  });

  it("throws when the API returns an error", async () => {
    const { client } = makeFakeWebClient([
      { ok: false, error: "missing_scope" },
    ]);
    await expect(
      resolveChannels(client as never, {
        inboxName: "x",
        alertsName: "y",
      }),
    ).rejects.toBeInstanceOf(ChannelResolveError);
  });
});
