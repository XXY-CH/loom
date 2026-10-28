import { createHash } from "node:crypto";
import type { ProviderProfile } from "./index.js";

/**
 * Connection semantics that pin one Run database to one connection: every
 * field that changes what the runtime talks to. `id` is deliberately excluded
 * — it labels a catalog entry, not a connection, so selecting the same
 * connection through a profile id and through raw CLI flags must derive one
 * identity. Undefined fields stringify away symmetrically on both forms.
 */
const CONNECTION_FIELDS = [
  "kind",
  "protocol",
  "modelId",
  "baseUrl",
  "keyEnv",
  "contextWindow",
  "maxTokens",
] as const;

type ConnectionSemantics = {
  kind: ProviderProfile["kind"];
  protocol: ProviderProfile["protocol"];
  modelId: string;
  // Optional fields accept explicit undefined: the derivation treats an
  // explicitly-undefined field and an absent field identically, matching both
  // caller forms (JSON round-tripped profiles never carry undefined keys; raw
  // CLI flag objects omit the ones the flags did not set).
  baseUrl?: string | undefined;
  keyEnv?: string | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
};

/**
 * Stable field-order SHA-256 (full hex, never truncated) over the non-secret
 * connection semantics. Shared by the CLI entry points and the service's
 * default runtime factory so a service-started Run and a later CLI reopen of
 * the same connection agree on the persisted connection identity
 * (`RuntimeSession` rejects any Run reopened under a different one). The
 * service start idempotency key keeps its own separate derivation and still
 * includes the profile id.
 */
export function connectionIdentity(profile: ConnectionSemantics): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          CONNECTION_FIELDS.map((field) => [field, profile[field]]),
        ),
      ),
    )
    .digest("hex");
}
