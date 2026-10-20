import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, test } from "vitest";
import { createProviderModels } from "../src/providers/index.js";
import { RuntimeSession } from "../src/runtime/session.js";

// Local protocol fixture; reported cache tokens are synthetic, not live hits.
test("Anthropic tools and cache usage run through RuntimeSession and survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-anthropic-http-"));
  await writeFile(join(root, "marker.txt"), "actual-local-tool-content");
  let calls = 0;
  const keys: unknown[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    calls += 1;
    keys.push(request.headers["x-api-key"]);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = `answer-${calls}`;
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg-${calls}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "fixture",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 3,
            output_tokens: 0,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block:
          calls === 1
            ? { type: "tool_use", id: "read-marker", name: "read", input: {} }
            : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta:
          calls === 1
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify({ path: "marker.txt" }),
              }
            : { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: calls === 1 ? "tool_use" : "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    response.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let runtime: RuntimeSession | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected fixture port");
    const provider = createProviderModels(
      {
        id: "anthropic-runtime",
        kind: "anthropic",
        protocol: "anthropic-messages",
        modelId: "fixture",
      },
      { ANTHROPIC_API_KEY: "fixture-key" },
    );
    const options = {
      ...provider,
      cwd: root,
      dbPath: join(root, "agent.sqlite"),
      connectionIdentity: "anthropic-runtime",
    };
    const selected = provider.models.getModel(
      provider.model.provider,
      "fixture",
    );
    if (!selected) throw new Error("Model not registered");
    selected.baseUrl = `http://127.0.0.1:${address.port}`;
    runtime = await RuntimeSession.open(options);
    const first = await (
      await runtime.submit({ content: "first", requestId: "one" })
    ).wait(BACKGROUND_CONTEXT);
    expect(first.status).toBe("done");
    expect(calls).toBe(2);
    expect(bodies[0]?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "read" })]),
    );
    expect(JSON.stringify(bodies[1]?.messages)).toContain(
      "actual-local-tool-content",
    );
    expect(JSON.stringify(bodies[1]?.messages)).toContain("tool_result");
    await runtime.close();
    runtime = await RuntimeSession.open(options);
    const second = await (
      await runtime.submit({ content: "second", requestId: "two" })
    ).wait(BACKGROUND_CONTEXT);
    expect(second.status).toBe("done");
    expect(calls).toBe(3);
    expect(keys).toEqual(["fixture-key", "fixture-key", "fixture-key"]);
    expect((await runtime.usageSummary()).total).toEqual({
      input: 9,
      output: 6,
      cacheRead: 15,
      cacheWrite: 6,
      cacheReadPromptRatio: 0.5,
    });
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
