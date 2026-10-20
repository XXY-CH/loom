import type { Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export type OpenAIProtocol = "openai-responses" | "openai-completions";
export type ProviderProtocol = OpenAIProtocol | "anthropic-messages";

/** Serializable connection settings. Credentials remain in the referenced environment. */
export interface ProviderProfile {
  id: string;
  kind: "openai" | "openai-compatible" | "anthropic";
  protocol: ProviderProtocol;
  modelId: string;
  baseUrl?: string;
  keyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export class ProviderConfigError extends Error {
  constructor(
    public readonly code: "INVALID_PROFILE" | "MISSING_KEY",
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

function invalid(message: string): never {
  throw new ProviderConfigError("INVALID_PROFILE", message);
}

function endpoint(profile: ProviderProfile): string {
  if (profile.kind === "anthropic") {
    if (profile.baseUrl !== undefined) {
      invalid(
        "Use anthropic's built-in endpoint; custom endpoints are openai-compatible.",
      );
    }
    return "https://api.anthropic.com";
  }
  if (profile.kind === "openai") {
    if (profile.baseUrl !== undefined) {
      invalid("Use openai-compatible for a custom endpoint.");
    }
    return "https://api.openai.com/v1";
  }
  if (typeof profile.baseUrl !== "string" || !profile.baseUrl.trim()) {
    invalid("A custom endpoint requires baseUrl.");
  }
  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    return invalid("Endpoint must be an absolute HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    invalid(
      "Endpoint must use HTTP or HTTPS without credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid("Model token limits must be positive safe integers.");
  }
  return value;
}

/** Construct one isolated Pi model collection without network calls or credential persistence. */
export function createProviderModels(
  profile: ProviderProfile,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile.id)) {
    invalid(
      "Profile id must contain 1–64 letters, digits, dots, underscores, or hyphens.",
    );
  }
  if (
    profile.kind !== "openai" &&
    profile.kind !== "openai-compatible" &&
    profile.kind !== "anthropic"
  ) {
    invalid("Unsupported provider kind.");
  }
  if (
    profile.kind === "anthropic" &&
    profile.protocol !== "anthropic-messages"
  ) {
    invalid("Anthropic requires the anthropic-messages protocol.");
  }
  if (
    profile.kind !== "anthropic" &&
    profile.protocol !== "openai-responses" &&
    profile.protocol !== "openai-completions"
  ) {
    invalid("OpenAI providers require an OpenAI protocol.");
  }
  if (
    typeof profile.modelId !== "string" ||
    !profile.modelId ||
    profile.modelId.length > 256 ||
    /\s/.test(profile.modelId) ||
    Array.from(profile.modelId).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    invalid(
      "Model id must be a nonempty identifier without whitespace or control characters.",
    );
  }
  const baseUrl = endpoint(profile);
  const keyEnv =
    profile.keyEnv ??
    (profile.kind === "openai"
      ? "OPENAI_API_KEY"
      : profile.kind === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : undefined);
  if (keyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    invalid("keyEnv must name an environment variable.");
  }
  const key = keyEnv === undefined ? undefined : env[keyEnv];
  if (keyEnv !== undefined && (typeof key !== "string" || !key.trim())) {
    throw new ProviderConfigError(
      "MISSING_KEY",
      `Required API key environment variable is missing: ${keyEnv}`,
    );
  }

  const provider = `loom:${profile.id}`;
  const catalog =
    profile.kind === "openai"
      ? openaiProvider()
          .getModels()
          .find((candidate) => candidate.id === profile.modelId)
      : profile.kind === "anthropic"
        ? anthropicProvider()
            .getModels()
            .find((candidate) => candidate.id === profile.modelId)
        : undefined;
  const contextWindow = positiveInteger(
    profile.contextWindow,
    catalog?.contextWindow ?? 32_768,
  );
  const maxTokens = positiveInteger(
    profile.maxTokens,
    Math.min(catalog?.maxTokens ?? 4_096, contextWindow),
  );
  if (maxTokens > contextWindow)
    invalid("maxTokens must not exceed contextWindow.");
  const selected: Model<ProviderProtocol> = {
    id: profile.modelId,
    name: profile.modelId,
    api: profile.protocol,
    provider,
    baseUrl,
    reasoning: catalog?.reasoning ?? false,
    input: catalog?.input ?? ["text"],
    // Pi requires numeric prices. Zero for unknown models is an SDK placeholder, not a price quote.
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(catalog?.api === profile.protocol && catalog.compat
      ? { compat: catalog.compat }
      : {}),
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: `Loom ${profile.id}`,
      baseUrl,
      models: [selected],
      auth: {
        apiKey: {
          name: "Loom API key",
          // SDK requires a nonempty key even for keyless servers. Null suppresses its Authorization header.
          resolve: async () => ({
            auth:
              key === undefined
                ? { apiKey: "loom-keyless", headers: { Authorization: null } }
                : { apiKey: key },
          }),
        },
      },
      api: {
        "openai-responses": openAIResponsesApi(),
        "openai-completions": openAICompletionsApi(),
        "anthropic-messages": anthropicMessagesApi(),
      },
    }),
  );
  return { models, model: { provider, modelId: profile.modelId } };
}
