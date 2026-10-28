import { readFile } from "node:fs/promises";
import { ProviderConfigError, type ProviderProfile } from "./index.js";

const fields = new Set([
  "id",
  "kind",
  "protocol",
  "modelId",
  "baseUrl",
  "keyEnv",
  "contextWindow",
  "maxTokens",
]);

/** Validate a decoded provider profile object; credentials stay in keyEnv-referenced environment. */
export function parseProviderProfile(value: unknown): ProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderConfigError(
      "INVALID_PROFILE",
      "Invalid provider profile: expected an object",
    );
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !fields.has(key));
  if (unknown.length)
    throw new ProviderConfigError(
      "INVALID_PROFILE",
      "Invalid provider profile: unknown fields; use keyEnv for credentials",
    );
  for (const required of ["id", "kind", "protocol", "modelId"])
    if (typeof record[required] !== "string" || !record[required])
      throw new ProviderConfigError(
        "INVALID_PROFILE",
        `Invalid provider profile: ${required} is required`,
      );
  for (const key of ["baseUrl", "keyEnv"]) {
    if (record[key] !== undefined && typeof record[key] !== "string")
      throw new ProviderConfigError(
        "INVALID_PROFILE",
        `Invalid provider profile: ${key} must be a string`,
      );
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    if (record[key] !== undefined && typeof record[key] !== "number")
      throw new ProviderConfigError(
        "INVALID_PROFILE",
        `Invalid provider profile: ${key} must be a number`,
      );
  }
  return {
    id: record.id as string,
    kind: record.kind as ProviderProfile["kind"],
    protocol: record.protocol as ProviderProfile["protocol"],
    modelId: record.modelId as string,
    ...(record.baseUrl === undefined
      ? {}
      : { baseUrl: record.baseUrl as string }),
    ...(record.keyEnv === undefined ? {} : { keyEnv: record.keyEnv as string }),
    ...(record.contextWindow === undefined
      ? {}
      : { contextWindow: record.contextWindow as number }),
    ...(record.maxTokens === undefined
      ? {}
      : { maxTokens: record.maxTokens as number }),
  };
}

export async function loadProviderProfile(
  path: string,
): Promise<ProviderProfile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ProviderConfigError(
      "INVALID_PROFILE",
      "Unable to read provider profile JSON.",
    );
  }
  return parseProviderProfile(value);
}
