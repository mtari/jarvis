import type { App as BoltApp } from "@slack/bolt";

/**
 * Test helpers for unit-testing Slack action / view / command handlers
 * registered via `registerHandlers(app, ctx)`. The fake Bolt app
 * captures every `app.action(id, fn)` / `app.view(id, fn)` /
 * `app.command(id, fn)` call so tests can invoke the matching handler
 * directly with a synthesized args object.
 *
 * Bolt's full handler types are wide — `BlockAction<ButtonAction>`,
 * `ViewSubmitAction`, etc., each pulling in many SDK type unions.
 * The fake here only models what our handlers actually use:
 *   - action handlers destructure `{ ack, body, action, client }`
 *   - view handlers destructure `{ ack, body, view, client }`
 *   - command handlers destructure `{ ack, command, respond, client }`
 *
 * Args are constructed by callers; we stay structurally typed and
 * cast the synthesized args to the wider Bolt types via `as never`.
 * The trade-off: tests catch the wiring + side-effect logic but
 * don't exercise the SDK's permission / signature checks (those are
 * Slack's responsibility, and out of scope for unit tests).
 */

export type ActionHandler = (args: ActionHandlerArgs) => Promise<void>;
export type ViewHandler = (args: ViewHandlerArgs) => Promise<void>;
export type CommandHandler = (args: CommandHandlerArgs) => Promise<void>;
export type MessageHandler = (args: MessageHandlerArgs) => Promise<void>;

export interface MessageHandlerArgs {
  message: Record<string, unknown>;
  client?: FakeWebClient;
}

export interface ActionHandlerArgs {
  ack: () => Promise<void>;
  body: ActionBody;
  action: { type: string; value?: string; action_id?: string };
  client?: FakeWebClient;
}

export interface ActionBody {
  type?: string;
  user?: { id?: string };
  trigger_id?: string;
  message?: { ts?: string; blocks?: Array<{ type?: string }> };
  channel?: { id?: string };
}

export interface ViewHandlerArgs {
  ack: (response?: {
    response_action?: "errors";
    errors?: Record<string, string>;
  }) => Promise<void>;
  body: { user: { id: string } };
  view: {
    private_metadata: string;
    state: { values: Record<string, Record<string, { value?: string; selected_options?: Array<{ value: string }> }>> };
  };
  client?: FakeWebClient;
}

export interface CommandHandlerArgs {
  ack: () => Promise<void>;
  command: { text?: string; channel_id?: string; user_id?: string; trigger_id?: string };
  respond: (args: {
    response_type: "ephemeral" | "in_channel";
    text?: string;
    blocks?: unknown[];
  }) => Promise<void>;
  client?: FakeWebClient;
}

interface FakeWebClient {
  chat: {
    postMessage: (args: {
      channel: string;
      text?: string;
      blocks?: unknown[];
    }) => Promise<{ ok: boolean; ts?: string; error?: string }>;
    update?: (args: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown;
    }) => Promise<{ ok: boolean; error?: string }>;
    postEphemeral?: (args: {
      channel: string;
      user: string;
      text: string;
    }) => Promise<{ ok: boolean }>;
  };
  views?: {
    open: (args: { trigger_id: string; view: unknown }) => Promise<{ ok: boolean }>;
  };
}

export interface FakeBoltApp {
  /** Bolt-typed proxy passed to `registerHandlers`. */
  app: BoltApp;
  invokeAction(id: string, args: Partial<ActionHandlerArgs>): Promise<void>;
  invokeView(id: string, args: Partial<ViewHandlerArgs>): Promise<void>;
  invokeCommand(id: string, args: Partial<CommandHandlerArgs>): Promise<void>;
  /** Fires every registered `app.message` handler in order. */
  invokeMessage(args: Partial<MessageHandlerArgs>): Promise<void>;
  /** Names of registered actions / views / commands — for assertions. */
  registeredActionIds(): string[];
  registeredViewIds(): string[];
  registeredCommandIds(): string[];
  /** Number of registered message handlers (Bolt allows multiple). */
  registeredMessageCount(): number;
}

export function makeFakeBoltApp(): FakeBoltApp {
  const actions = new Map<string, ActionHandler>();
  const views = new Map<string, ViewHandler>();
  const commands = new Map<string, CommandHandler>();
  const messages: MessageHandler[] = [];

  const proxy = {
    action(id: string, handler: ActionHandler) {
      actions.set(id, handler);
    },
    view(id: string, handler: ViewHandler) {
      views.set(id, handler);
    },
    command(id: string, handler: CommandHandler) {
      commands.set(id, handler);
    },
    message(handler: MessageHandler) {
      messages.push(handler);
    },
  };

  return {
    app: proxy as never,
    async invokeAction(id, args) {
      const handler = actions.get(id);
      if (!handler) {
        throw new Error(`No action handler registered for id "${id}"`);
      }
      await handler(buildActionArgs(args));
    },
    async invokeView(id, args) {
      const handler = views.get(id);
      if (!handler) {
        throw new Error(`No view handler registered for id "${id}"`);
      }
      await handler(buildViewArgs(args));
    },
    async invokeCommand(id, args) {
      const handler = commands.get(id);
      if (!handler) {
        throw new Error(`No command handler registered for id "${id}"`);
      }
      await handler(buildCommandArgs(args));
    },
    async invokeMessage(args) {
      const built = buildMessageArgs(args);
      for (const h of messages) {
        await h(built);
      }
    },
    registeredActionIds: () => [...actions.keys()],
    registeredViewIds: () => [...views.keys()],
    registeredCommandIds: () => [...commands.keys()],
    registeredMessageCount: () => messages.length,
  };
}

/**
 * Records `chat.postMessage` / `chat.update` calls so tests can assert
 * on them. Returns success by default; pass `{simulateError: true}`
 * to surface a postMessage `ok: false` for error-path tests.
 */
export interface RecordingClient {
  client: FakeWebClient;
  posts: Array<{ channel: string; text?: string; blocks?: unknown[] }>;
  updates: Array<{ channel: string; ts: string; text?: string; blocks?: unknown }>;
  postEphemerals: Array<{ channel: string; user: string; text: string }>;
  viewsOpened: Array<{ trigger_id: string; view: unknown }>;
}

export function recordingClient(
  opts: { simulateError?: boolean } = {},
): RecordingClient {
  const posts: RecordingClient["posts"] = [];
  const updates: RecordingClient["updates"] = [];
  const postEphemerals: RecordingClient["postEphemerals"] = [];
  const viewsOpened: RecordingClient["viewsOpened"] = [];
  let counter = 1;
  const client: FakeWebClient = {
    chat: {
      async postMessage(args) {
        posts.push({ ...args });
        if (opts.simulateError) return { ok: false, error: "channel_not_found" };
        return { ok: true, ts: `1700000000.00${counter++}` };
      },
      async update(args) {
        updates.push({ ...args });
        return { ok: true };
      },
      async postEphemeral(args) {
        postEphemerals.push({ ...args });
        return { ok: true };
      },
    },
    views: {
      async open(args) {
        viewsOpened.push({ ...args });
        return { ok: true };
      },
    },
  };
  return { client, posts, updates, postEphemerals, viewsOpened };
}

// ---------------------------------------------------------------------------
// Args constructors with safe defaults — keep callers terse
// ---------------------------------------------------------------------------

function buildActionArgs(p: Partial<ActionHandlerArgs>): ActionHandlerArgs {
  return {
    ack: p.ack ?? (async () => {}),
    body: p.body ?? { type: "block_actions", user: { id: "U-test" } },
    action: p.action ?? { type: "button", value: "" },
    ...(p.client !== undefined && { client: p.client }),
  };
}

function buildViewArgs(p: Partial<ViewHandlerArgs>): ViewHandlerArgs {
  return {
    ack: p.ack ?? (async () => {}),
    body: p.body ?? { user: { id: "U-test" } },
    view: p.view ?? {
      private_metadata: "",
      state: { values: {} },
    },
    ...(p.client !== undefined && { client: p.client }),
  };
}

function buildCommandArgs(p: Partial<CommandHandlerArgs>): CommandHandlerArgs {
  return {
    ack: p.ack ?? (async () => {}),
    command: p.command ?? { text: "", channel_id: "C-test" },
    respond: p.respond ?? (async () => {}),
    ...(p.client !== undefined && { client: p.client }),
  };
}

function buildMessageArgs(p: Partial<MessageHandlerArgs>): MessageHandlerArgs {
  return {
    message: p.message ?? { type: "message" },
    ...(p.client !== undefined && { client: p.client }),
  };
}
