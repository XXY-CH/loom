import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, test } from "vitest";
import { createProviderModels } from "../src/providers/index.js";
import { RuntimeSession } from "../src/runtime/session.js";

// Local protocol fixture: cached_tokens below is synthetic, not a live cache hit.
test("Responses cache routing survives Runtime restart and decodes reported cached tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-cache-http-"));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const item = {
      id: `message-${requests.length}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "fixture answer", annotations: [] },
      ],
    };
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "fixture answer",
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `response-${requests.length}`,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 2000,
            output_tokens: 10,
            total_tokens: 2010,
            input_tokens_details: {
              cached_tokens: requests.length === 1 ? 0 : 1500,
            },
          },
        },
      },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
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
        id: "cache-http",
        kind: "openai-compatible",
        protocol: "openai-responses",
        modelId: "fixture",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      {},
    );
    const options = {
      ...provider,
      cwd: root,
      dbPath: join(root, "agent.sqlite"),
      connectionIdentity: "local-cache-http",
    };
    runtime = await RuntimeSession.open(options);
    await (
      await runtime.submit({ content: "stable goal", requestId: "first" })
    ).wait(BACKGROUND_CONTEXT);
    await runtime.close();
    runtime = await RuntimeSession.open(options);
    await (
      await runtime.submit({ content: "continue", requestId: "second" })
    ).wait(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.prompt_cache_key).toEqual(expect.any(String));
    expect(requests[1]?.prompt_cache_key).toBe(requests[0]?.prompt_cache_key);
    const [firstInput, secondInput] = requests.map(
      ({ input }) => input as unknown[],
    );
    expect(secondInput?.slice(0, firstInput?.length)).toEqual(firstInput);
    expect(requests.map((request) => request.model)).toEqual([
      "fixture",
      "fixture",
    ]);
    const entries = await runtime.entries();
    const usage = entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => message.usage);
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({
      input: 500,
      cacheRead: 1500,
      cacheWrite: 0,
      output: 10,
    });
    expect((await runtime.usageSummary()).total).toEqual({
      input: 2500,
      output: 20,
      cacheRead: 1500,
      cacheWrite: 0,
      cacheReadPromptRatio: 0.375,
    });
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
