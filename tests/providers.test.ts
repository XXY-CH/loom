import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { connectionIdentity } from "../src/providers/identity.js";
import {
  createProviderModels,
  type OpenAIProtocol,
  type ProviderProfile,
} from "../src/providers/index.js";

const custom: ProviderProfile = {
  id: "local",
  kind: "openai-compatible",
  protocol: "openai-completions",
  modelId: "local/model",
  baseUrl: "http://127.0.0.1:11434/v1",
};

describe("connection identity derivation", () => {
  // The two input shapes every caller produces: raw CLI flags assemble a bare
  // connection object, while the service and the catalog resolve a full
  // ProviderProfile (JSON round-tripped, so optional fields are absent).
  const rawFlagForm = {
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "local/model",
    baseUrl: "http://127.0.0.1:11434/v1",
  } as const;
  const profileForm: ProviderProfile = {
    id: "local",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "local/model",
    baseUrl: "http://127.0.0.1:11434/v1",
  };

  it("derives one identity for the CLI flag form and the service profile form", () => {
    expect(connectionIdentity(profileForm)).toBe(
      connectionIdentity(rawFlagForm),
    );
  });

  it("excludes the catalog id and emits the full SHA-256 hex", () => {
    const renamed: ProviderProfile = { ...profileForm, id: "another-entry" };
    expect(connectionIdentity(renamed)).toBe(connectionIdentity(profileForm));
    expect(connectionIdentity(profileForm)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["kind", "openai"],
    ["protocol", "openai-responses"],
    ["modelId", "other/model"],
    ["baseUrl", "http://127.0.0.1:1/v1"],
    ["keyEnv", "CHOSEN_KEY"],
    ["contextWindow", 8192],
    ["maxTokens", 512],
  ] as const)("changes identity when %s differs", (field, value) => {
    expect(connectionIdentity({ ...rawFlagForm, [field]: value })).not.toBe(
      connectionIdentity(rawFlagForm),
    );
  });

  it("treats undefined and absent optional fields symmetrically on both forms", () => {
    expect(
      connectionIdentity({
        kind: "openai",
        protocol: "openai-responses",
        modelId: "gpt-4.1",
        baseUrl: undefined,
        keyEnv: undefined,
        contextWindow: undefined,
        maxTokens: undefined,
      }),
    ).toBe(
      connectionIdentity({
        kind: "openai",
        protocol: "openai-responses",
        modelId: "gpt-4.1",
      }),
    );
  });
});

describe("provider configuration", () => {
  it("supports the built-in Anthropic Messages endpoint with isolated API-key auth", async () => {
    let receivedPath: string | undefined;
    let receivedKey: string | undefined;
    let receivedModel: string | undefined;
    const server = createServer(async (request, response) => {
      receivedPath = request.url;
      const keyHeader = request.headers["x-api-key"];
      receivedKey = typeof keyHeader === "string" ? keyHeader : undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      receivedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-fixture",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      response.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const { models, model } = createProviderModels(
        {
          id: "anthropic-fixture",
          kind: "anthropic",
          protocol: "anthropic-messages",
          modelId: "claude-fixture",
        },
        {
          ANTHROPIC_API_KEY: "fixture-anthropic-key",
          OPENAI_API_KEY: "must-not-leak",
        },
      );
      const selected = models.getModel(model.provider, model.modelId);
      if (!selected) throw new Error("Model not registered");
      // Redirect only this isolated model; the built-in endpoint remains the profile identity.
      selected.baseUrl = `http://127.0.0.1:${address.port}`;
      const result = await models.completeSimple(selected, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      });
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "hello" }),
      );
      expect(receivedPath).toMatch(/^\/v1\/messages(?:\?beta=true)?$/);
      expect(receivedModel).toBe("claude-fixture");
      expect(receivedKey).toBe("fixture-anthropic-key");
      expect(model.provider).not.toBe("loom:local");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("requires Anthropic's selected key without falling back to OpenAI", () => {
    expect(() =>
      createProviderModels(
        {
          id: "anthropic",
          kind: "anthropic",
          protocol: "anthropic-messages",
          modelId: "claude-fixture",
        },
        { OPENAI_API_KEY: "openai-only" },
      ),
    ).toThrow("ANTHROPIC_API_KEY");
  });

  it("resolves only the explicitly selected API key and isolates provider identities", async () => {
    const profile = { ...custom, keyEnv: "CHOSEN_KEY" };
    const { models, model } = createProviderModels(profile, {
      CHOSEN_KEY: "chosen",
      OPENAI_API_KEY: "other",
    });
    expect(model).toEqual({ provider: "loom:local", modelId: "local/model" });
    const auth = await models.getAuth(model.provider);
    expect(auth?.auth.apiKey).toBe("chosen");
    expect(JSON.stringify(profile)).not.toContain("chosen");
    expect(
      createProviderModels({ ...custom, id: "second" }).model.provider,
    ).not.toBe(model.provider);
  });

  it("requires the built-in API key without exposing secrets or falling back", () => {
    const profile: ProviderProfile = {
      id: "official",
      kind: "openai",
      protocol: "openai-responses",
      modelId: "gpt-4.1",
    };
    expect(() => createProviderModels(profile, {})).toThrow("OPENAI_API_KEY");
    expect(() =>
      createProviderModels(
        { ...custom, keyEnv: "MISSING" },
        { OPENAI_API_KEY: "do-not-fallback" },
      ),
    ).toThrow("MISSING");
    const { models, model } = createProviderModels(profile, {
      OPENAI_API_KEY: "example-secret",
    });
    expect(models.getModel(model.provider, model.modelId)?.baseUrl).toBe(
      "https://api.openai.com/v1",
    );
  });

  it.each([
    { ...custom, modelId: "" },
    { ...custom, modelId: "model\nsecret" },
    { ...custom, id: "../bad" },
    { ...custom, baseUrl: "file:///tmp/model" },
    { ...custom, baseUrl: "https://user:private-secret@example.com/v1" },
    { ...custom, baseUrl: "https://example.com/v1?api_key=private-secret" },
    { ...custom, keyEnv: "BAD KEY" },
    { ...custom, maxTokens: 0 },
    { ...custom, contextWindow: 100, maxTokens: 101 },
    { ...custom, kind: "openai", baseUrl: "https://example.com/v1" },
    { ...custom, protocol: "unknown" },
  ])(
    "rejects invalid connection settings without echoing credentials",
    (profile) => {
      let message = "";
      try {
        createProviderModels(profile as ProviderProfile);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("ProviderConfigError");
      expect(message).not.toContain("private-secret");
    },
  );
});

describe.each<OpenAIProtocol>(["openai-completions", "openai-responses"])(
  "%s transport",
  (protocol) => {
    it.each([false, true])(
      "uses the selected endpoint and sends authentication only when configured (key: %s)",
      async (withKey) => {
        let receivedPath: string | undefined;
        let receivedAuthorization: string | undefined;
        let receivedModel: string | undefined;
        const server = createServer(async (request, response) => {
          receivedPath = request.url;
          receivedAuthorization = request.headers.authorization;
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          receivedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          if (protocol === "openai-completions") {
            response.end(
              `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            );
          } else {
            const item = {
              id: "m1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "hello", annotations: [] },
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
                delta: "hello",
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "r1",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ];
            response.end(
              events
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = server.address() as AddressInfo;
          const { models, model } = createProviderModels(
            {
              ...custom,
              protocol,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              ...(withKey ? { keyEnv: "TEST_KEY" } : {}),
            },
            { TEST_KEY: "selected-key", OPENAI_API_KEY: "must-not-leak" },
          );
          const selected = models.getModel(model.provider, model.modelId);
          if (!selected) throw new Error("Model not registered");
          const result = await models.completeSimple(selected, {
            messages: [{ role: "user", content: "hello", timestamp: 0 }],
          });
          expect(result.stopReason).toBe("stop");
          expect(result.content).toContainEqual(
            expect.objectContaining({ type: "text", text: "hello" }),
          );
          expect(receivedPath).toBe(
            protocol === "openai-completions"
              ? "/v1/chat/completions"
              : "/v1/responses",
          );
          expect(receivedModel).toBe("local/model");
          expect(receivedAuthorization).toBe(
            withKey ? "Bearer selected-key" : undefined,
          );
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  },
);
