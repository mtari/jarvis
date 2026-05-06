import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxDir } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import {
  createFileStubAdapter,
  STUB_OUTPUT_FILENAME,
} from "./file-stub.ts";
import type { PublishInput } from "./types.ts";

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    postId: "post-1",
    planId: "plan-1",
    appId: "demo",
    content: "hello",
    assets: [],
    channel: "facebook",
    ...overrides,
  };
}

describe("createFileStubAdapter", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("appends a JSONL line per publish + returns ok:true with a stable id", async () => {
    const adapter = createFileStubAdapter({
      dataDir: sandbox.dataDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });
    const result = await adapter.publish(input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publishedId).toBe("stub-post-1");
    }

    const file = path.join(sandboxDir(sandbox.dataDir), STUB_OUTPUT_FILENAME);
    const content = fs.readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(content);
    expect(parsed).toMatchObject({
      publishedId: "stub-post-1",
      postId: "post-1",
      channel: "facebook",
      content: "hello",
      publishedAt: "2026-04-08T12:00:00.000Z",
    });
  });

  it("appends multiple lines across multiple publishes", async () => {
    const adapter = createFileStubAdapter({ dataDir: sandbox.dataDir });
    await adapter.publish(input({ postId: "a" }));
    await adapter.publish(input({ postId: "b" }));
    const file = path.join(sandboxDir(sandbox.dataDir), STUB_OUTPUT_FILENAME);
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.postId)).toEqual(["a", "b"]);
  });

  it("serves all SUPPORTED_CHANNELS by default", () => {
    const adapter = createFileStubAdapter({ dataDir: sandbox.dataDir });
    expect(adapter.channels.length).toBeGreaterThan(0);
    expect(adapter.channels).toContain("facebook");
    expect(adapter.channels).toContain("instagram");
  });

  it("respects an explicit channels override", () => {
    const adapter = createFileStubAdapter({
      dataDir: sandbox.dataDir,
      channels: ["blog"],
    });
    expect(adapter.channels).toEqual(["blog"]);
  });
});
