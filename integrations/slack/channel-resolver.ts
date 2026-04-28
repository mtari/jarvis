import type { WebClient } from "@slack/web-api";

export interface ResolvedChannels {
  inbox: string;
  alerts: string;
}

export interface ChannelResolveOptions {
  inboxName: string;
  alertsName: string;
}

export class ChannelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelResolveError";
  }
}

function stripHash(name: string): string {
  return name.startsWith("#") ? name.slice(1) : name;
}

/**
 * Resolves channel names like `#jarvis-inbox` to their Slack channel ids.
 * Fetches the bot's joined channels and looks them up by name.
 */
export async function resolveChannels(
  client: WebClient,
  opts: ChannelResolveOptions,
): Promise<ResolvedChannels> {
  const inboxName = stripHash(opts.inboxName);
  const alertsName = stripHash(opts.alertsName);

  const wanted = new Set([inboxName, alertsName]);
  const found = new Map<string, string>();

  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor !== undefined && { cursor }),
    });
    if (!result.ok || !result.channels) {
      throw new ChannelResolveError(
        `conversations.list failed: ${result.error ?? "unknown"}`,
      );
    }
    for (const ch of result.channels) {
      if (ch.name && ch.id && wanted.has(ch.name)) {
        found.set(ch.name, ch.id);
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor === "") cursor = undefined;
  } while (cursor && (!found.has(inboxName) || !found.has(alertsName)));

  const inbox = found.get(inboxName);
  const alerts = found.get(alertsName);

  if (!inbox) {
    throw new ChannelResolveError(
      `channel #${inboxName} not found. Create it and invite the bot with /invite @Jarvis.`,
    );
  }
  if (!alerts) {
    throw new ChannelResolveError(
      `channel #${alertsName} not found. Create it and invite the bot with /invite @Jarvis.`,
    );
  }
  return { inbox, alerts };
}
