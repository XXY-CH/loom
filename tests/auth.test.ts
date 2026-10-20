import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatGPTAuthService,
  FileCredentialStore,
  type OAuthCredential,
} from "../src/auth/index.js";

const directories: string[] = [];
const realFetch = globalThis.fetch;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "loom-auth-"));
  directories.push(directory);
  const store = new FileCredentialStore(directory);
  return { directory, store, service: new ChatGPTAuthService(store) };
}
const credential: OAuthCredential = {
  type: "oauth",
  access: "fixture-access-secret",
  refresh: "fixture-refresh-secret",
  expires: 1,
  clientId: "issued-fixture",
  scopes: ["chatgpt.tokens.use.direct"],
};
function token(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "new-access-secret",
      refresh_token: "rotated-refresh-secret",
      expires_in: 3600,
      scope: "openid chatgpt.tokens.use.direct",
      id_token: "unverified-upstream-fixture",
      ...overrides,
    }),
    { status: 200 },
  );
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe.sequential("ChatGPT experimental OAuth", () => {
  it("uses upstream browser callback with state, PKCE, Loom identity and direct scope", async () => {
    const { store, service } = await fixture();
    const hostId = await store.getHostId();
    let deliver: (url: URL) => void = () => {};
    const authorization = new Promise<URL>((resolve) => {
      deliver = resolve;
    });
    let challenge = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith("http://127.0.0.1:1455"))
          return realFetch(input, init);
        expect(String(input)).toBe(
          "https://auth.openai.com/api/accounts/oauth/token",
        );
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("issued-fixture");
        expect(body.get("code")).toBe("fixture-code");
        expect(
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge);
        return token();
      }),
    );
    const login = service.login({
      allowExperimental: true,
      onAuthUrl: (url) => deliver(new URL(url)),
    });
    const url = await authorization;
    challenge = url.searchParams.get("code_challenge") ?? "";
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("agent_name_hint")).toBe("Loom");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(
      `urn:uuid:${hostId}`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "fixture-code",
      state: "wrong-state",
      client_id: "issued-fixture",
    }).toString();
    expect((await realFetch(callback)).status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    expect((await realFetch(callback)).status).toBe(200);
    await login;
    expect((await store.read("openai"))?.type).toBe("oauth");
    expect(await service.status()).toMatchObject({
      connected: true,
      identityVerified: false,
      status: "experimental",
    });
    expect(JSON.stringify(await service.status())).not.toContain("secret");
  });

  it("cancels browser login and releases the callback port", async () => {
    const { service } = await fixture();
    const controller = new AbortController();
    await expect(
      service.login({
        allowExperimental: true,
        signal: controller.signal,
        onAuthUrl: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
    await expect(
      service.login({
        allowExperimental: true,
        onAuthUrl: () => {
          throw new Error("UI unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
    expect((await service.status()).connected).toBe(false);
  });

  it("serializes rotating refresh across instances and removes credentials on local logout", async () => {
    const { store, service, directory } = await fixture();
    await store.modify("openai", async () => credential);
    const fetch = vi.fn(async () => token());
    vi.stubGlobal("fetch", fetch);
    const second = new ChatGPTAuthService(new FileCredentialStore(directory));
    const refreshed = await Promise.all([
      service.getCredential(),
      second.getCredential(),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refreshed.map((value) => value.refresh)).toEqual([
      "rotated-refresh-secret",
      "rotated-refresh-secret",
    ]);
    await second.logout();
    expect((await service.status()).connected).toBe(false);
    await expect(service.getCredential()).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
  });

  it("preserves credentials and sanitizes token endpoint errors and missing scopes", async () => {
    const { store, service } = await fixture();
    await store.modify("openai", async () => credential);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private-refresh-secret", { status: 400 }),
      ),
    );
    await expect(service.getCredential()).rejects.toThrow(
      "ChatGPT refresh failed; existing credentials were preserved.",
    );
    expect(await store.read("openai")).toEqual(credential);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => token({ scope: "openid" })),
    );
    await expect(service.getCredential()).rejects.toMatchObject({
      code: "REFRESH_FAILED",
    });
    expect(await store.read("openai")).toEqual(credential);
  });
});

describe("private auth file", () => {
  it("keeps a stable host ID and writes owner-only atomic files", async () => {
    const { store, directory } = await fixture();
    const hostId = await store.getHostId();
    expect(await new FileCredentialStore(directory).getHostId()).toBe(hostId);
    await store.modify("openai", async () => credential);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["credentials-v1.json"]);
    expect(await store.list()).toEqual([
      { providerId: "openai", type: "oauth" },
    ]);
    const before = await readFile(store.path, "utf8");
    await expect(
      store.modify("openai", async () => {
        throw new Error("refresh rejected");
      }),
    ).rejects.toThrow("refresh rejected");
    expect(await readFile(store.path, "utf8")).toBe(before);
  });

  it("rejects unsafe permissions, symlinks and another process lock", async () => {
    const { store, directory } = await fixture();
    await store.getHostId();
    await chmod(store.path, 0o644);
    await expect(store.read("openai")).rejects.toMatchObject({
      code: "UNSAFE_STORAGE",
    });
    await rm(store.path);
    const target = join(directory, "target");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, store.path);
    await expect(store.read("openai")).rejects.toMatchObject({
      code: "UNSAFE_STORAGE",
    });
    await rm(store.path);
    await mkdir(`${store.path}.lock`, { mode: 0o700 });
    await expect(store.getHostId()).rejects.toMatchObject({
      code: "AUTH_BUSY",
    });
  });
});
