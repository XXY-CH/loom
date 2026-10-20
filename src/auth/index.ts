import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  AuthError,
  FileCredentialStore,
  type OAuthCredential,
} from "./store.js";

export type { Credential, CredentialStore, OAuthCredential } from "./store.js";
export { AuthError, FileCredentialStore } from "./store.js";

export const chatGPTAuthCapability = {
  status: "experimental",
  login: "browser-loopback",
  callback: "http://127.0.0.1:1455/auth/callback",
  deviceCode: false,
  identityVerified: false,
  issuedClientReuse: false,
  reason:
    "pi-ai 1.3.0 does not verify ID-token identity claims and registers a new client on every login.",
} as const;

export interface ChatGPTLoginOptions {
  /** Explicit acknowledgement of the upstream identity-verification gaps. */
  allowExperimental: true;
  onAuthUrl(url: string): void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Uses Pi's public OAuthAuth, never a CLI or another application's credentials. */
export class ChatGPTAuthService {
  constructor(readonly store = new FileCredentialStore()) {}

  async status() {
    const credential = await this.store.read("openai");
    return {
      ...chatGPTAuthCapability,
      connected: credential?.type === "oauth",
      ...(credential?.type === "oauth" ? { expires: credential.expires } : {}),
    };
  }

  async login(options: ChatGPTLoginOptions): Promise<void> {
    if (options.allowExperimental !== true)
      throw new AuthError(
        "EXPERIMENTAL_REQUIRED",
        "ChatGPT login requires explicit experimental opt-in.",
      );
    if (
      process.env.PI_OAUTH_CALLBACK_HOST &&
      process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1"
    )
      throw new AuthError(
        "UNSAFE_CALLBACK",
        "PI_OAUTH_CALLBACK_HOST must be unset or 127.0.0.1.",
      );
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 15 * 60_000
    )
      throw new AuthError(
        "INVALID_TIMEOUT",
        "Login timeout must be between 1 and 900000 milliseconds.",
      );
    const interactionAbort = new AbortController();
    const signal = AbortSignal.any([
      interactionAbort.signal,
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const hostId = await this.store.getHostId();
    try {
      // Hold the same lock used for refresh/logout, including across processes.
      await this.store.modify("openai", async () => {
        const credential = await this.oauth().login(
          {
            signal,
            notify: (event) => {
              if (event.type !== "auth_url") return;
              try {
                const url = new URL(event.url);
                if (
                  url.origin !== "https://auth.openai.com" ||
                  url.pathname !== "/api/accounts/authorize"
                )
                  throw new AuthError(
                    "UNSAFE_AUTH_URL",
                    "Unexpected authorization endpoint.",
                  );
                options.onAuthUrl(url.toString());
              } catch {
                // Upstream calls notify before entering its cleanup block. Abort the
                // prompt instead of throwing here so its callback server is closed.
                interactionAbort.abort();
              }
            },
            // No paste-back prompt: callback codes must never enter chat, logs, or history.
            prompt: (prompt) =>
              new Promise<string>((_resolve, reject) => {
                const promptSignal = prompt.signal ?? signal;
                const abort = () =>
                  reject(
                    new AuthError(
                      "LOGIN_CANCELLED",
                      "Login cancelled or timed out.",
                    ),
                  );
                if (promptSignal.aborted) abort();
                else
                  promptSignal.addEventListener("abort", abort, { once: true });
              }),
          },
          { getDeviceId: () => hostId, agentName: "Loom" },
        );
        this.validate(credential);
        return credential;
      });
    } catch {
      throw new AuthError(
        signal.aborted ? "LOGIN_CANCELLED" : "LOGIN_FAILED",
        signal.aborted
          ? "Login cancelled or timed out."
          : "ChatGPT experimental login failed; existing credentials were preserved.",
      );
    }
  }

  /** Secret-bearing integration method: only pass the result to the official OpenAI provider. */
  async getCredential(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<OAuthCredential> {
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    signal.throwIfAborted();
    try {
      const credential = await this.store.modify("openai", async (current) => {
        if (current?.type !== "oauth")
          throw new AuthError("RECONNECT_REQUIRED", "Connect ChatGPT first.");
        this.validate(current);
        if (!options.forceRefresh && current.expires > Date.now())
          return current;
        const refreshed = await this.oauth().refresh(current, signal);
        this.validate(refreshed);
        return refreshed;
      });
      return credential as OAuthCredential;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        "REFRESH_FAILED",
        "ChatGPT refresh failed; existing credentials were preserved. Reconnect if authorization has expired.",
      );
    }
  }

  /** Local logout only; Pi exposes no server-side token revocation operation. */
  async logout(): Promise<void> {
    await this.store.delete("openai");
  }

  private oauth() {
    const oauth = openaiProvider().auth.oauth;
    if (!oauth)
      throw new AuthError(
        "OAUTH_UNAVAILABLE",
        "The installed Pi provider does not expose ChatGPT OAuth.",
      );
    return oauth;
  }

  private validate(credential: OAuthCredential) {
    if (
      !credential.access?.trim() ||
      !credential.refresh?.trim() ||
      !Number.isFinite(credential.expires) ||
      typeof credential.clientId !== "string" ||
      !credential.clientId.trim() ||
      !Array.isArray(credential.scopes) ||
      !credential.scopes.includes("chatgpt.tokens.use.direct")
    )
      throw new AuthError(
        "INVALID_CREDENTIAL",
        "ChatGPT credential is incomplete or lacks the direct token scope.",
      );
  }
}
