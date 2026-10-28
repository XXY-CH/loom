import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderProfile } from "../providers/index.js";
import type { FeatureSpec } from "../workflow/feature-store.js";
import type { RunSummary } from "./catalog.js";
import type { ServiceRequest, ServiceResult } from "./daemon.js";

/** Owner-only token file inside dataRoot; regenerated on every service start. */
export const httpTokenPath = (dataRoot: string) =>
  join(resolve(dataRoot), "http-token");

const LOOPBACK_HOST = "127.0.0.1";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
// Two levels up covers both src/service (tsx) and dist/service (built): the
// compiled layout keeps the same depth below the project root.
const DEFAULT_WEB_ROOT = fileURLToPath(
  new URL("../../web/dist", import.meta.url),
);
const MAX_STATIC_FILE_BYTES = 4 * 1024 * 1024;
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** Same request surface as the Unix socket; HTTP never bypasses service gating. */
export interface HttpTransport {
  request(serviceRequest: ServiceRequest): Promise<ServiceResult>;
}

type EventStream = {
  response: ServerResponse;
  timer: ReturnType<typeof setTimeout> | undefined;
};

class BodyLimitError extends Error {}
class BodyTimeoutError extends Error {}

/**
 * Token-gated loopback HTTP projection of a LoomService. Read endpoints return
 * the same RunSummary snapshots as the socket protocol, plus the read-only
 * diff (aggregate, single file/layer, paginated file index), evidence,
 * evidence artifact body, and connection catalog (when enabled via --catalog)
 * projections; actions (start, cancel, resume, reconcile-budget, and the
 * connection catalog writes POST /connections, PUT /connections/:id, DELETE
 * /connections/:id) pass straight through LoomService.request. SSE is a polled
 * snapshot projection (initial snapshot on connect, then pushes on any
 * RunSummary diff), not an event bus.
 *
 * When a built workbench directory exists, its static assets are additionally
 * served without a token for same-origin access: assets carry no Run data and
 * every data endpoint keeps its exact 401/404 behavior.
 */
export class ServiceHttpProjection {
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<EventStream>();
  private readonly server: Server;
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly transport: HttpTransport,
    private readonly token: string,
    readonly tokenPath: string,
    readonly pollIntervalMs: number,
    private readonly bodyTimeoutMs: number,
    /** Absolute real path of the built workbench, or null when absent. */
    private readonly webRoot: string | null,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async open(
    transport: HttpTransport,
    options: {
      dataRoot: string;
      pollIntervalMs?: number;
      bodyTimeoutMs?: number;
      /** Built workbench directory to serve; defaults to web/dist when present. */
      webRoot?: string;
    },
  ): Promise<ServiceHttpProjection> {
    const tokenPath = httpTokenPath(options.dataRoot);
    const token = randomBytes(32).toString("hex");
    // dataRoot itself is owner-only (0o700); the token file must match.
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    // Static serving activates only for an existing directory; a missing or
    // non-directory webRoot keeps the projection exactly as data-only.
    let webRoot: string | null = null;
    const candidate = resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
    try {
      const real = await realpath(candidate);
      if ((await stat(real)).isDirectory()) webRoot = real;
    } catch {
      webRoot = null;
    }
    const projection = new ServiceHttpProjection(
      transport,
      token,
      tokenPath,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
      webRoot,
    );
    try {
      await new Promise<void>((accept, reject) => {
        projection.server.once("error", reject);
        projection.server.listen(0, LOOPBACK_HOST, () => {
          projection.server.removeListener("error", reject);
          accept();
        });
      });
    } catch (error) {
      await projection.close().catch(() => {});
      throw error;
    }
    return projection;
  }

  /** Ephemeral port on loopback; the entry prints it alongside the token path. */
  get address(): { host: string; port: number } {
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("HTTP projection is not listening");
    return { host: address.address, port: address.port };
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const stream of this.streams) {
        if (stream.timer) clearTimeout(stream.timer);
        stream.response.destroy();
      }
      this.streams.clear();
      for (const socket of this.sockets) socket.destroy();
      if (this.server.listening)
        await new Promise<void>((accept, reject) =>
          this.server.close((error) => (error ? reject(error) : accept())),
        );
      // Symmetric with daemon.ts removing loom.sock; the token dies with the listener.
      await rm(this.tokenPath, { force: true });
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private authorized(header: string | string[] | undefined): boolean {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith("Bearer ")) return false;
    const provided = createHash("sha256")
      .update(value.slice("Bearer ".length).trim())
      .digest();
    const expected = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(provided, expected);
  }

  private fail(response: ServerResponse, status: number, error: string): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify({ ok: false, error })}\n`);
  }

  private async project(
    response: ServerResponse,
    pending: Promise<ServiceResult>,
  ): Promise<void> {
    try {
      const result = await pending;
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Service request failed";
      // Structured pass-through; unknown run ids are the only 404 mapping.
      this.fail(response, message === "Unknown Run" ? 404 : 400, message);
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((accept, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      // A stalled client sends neither end nor error; only a timeout ends the wait.
      request.setTimeout(this.bodyTimeoutMs, () =>
        settle(() => reject(new BodyTimeoutError())),
      );
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          settle(() => reject(new BodyLimitError()));
          request.removeAllListeners("data");
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => settle(() => accept(Buffer.concat(chunks))));
      request.on("error", (error) => settle(() => reject(error)));
      // Premature close (client interrupt) must settle too, never hang the handler.
      request.on("close", () =>
        settle(() => reject(new Error("Request body incomplete"))),
      );
    });
  }

  /** Reads (or drains) the body; every failure gets an explicit response and terminates. */
  private async readRequestBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Buffer | undefined> {
    try {
      return await this.readBody(request);
    } catch (error) {
      if (error instanceof BodyLimitError) {
        this.fail(response, 413, "Request body exceeds limit");
        request.destroy();
      } else if (error instanceof BodyTimeoutError) {
        this.fail(response, 408, "Request body timed out");
        // Deliver the status first, then tear down the stalled connection.
        response.once("finish", () => request.destroy());
      } else {
        this.fail(response, 400, "Request body interrupted");
        request.destroy();
      }
      return undefined;
    }
  }

  /**
   * Serves one static file from webRoot without a token. Returns false when
   * the path is not a servable file so the request falls through to the
   * unchanged token-gated routing (missing files therefore keep the exact
   * 401/404 behavior of a data-only projection).
   */
  private async serveStatic(
    pathname: string,
    response: ServerResponse,
    headOnly: boolean,
  ): Promise<boolean> {
    if (!this.webRoot) return false;
    // API routes are never shadowed by files, whatever webRoot contains.
    if (
      pathname === "/runs" ||
      pathname === "/events" ||
      pathname === "/connections" ||
      pathname.startsWith("/runs/") ||
      pathname.startsWith("/events/") ||
      pathname.startsWith("/connections/")
    )
      return false;
    const segments =
      pathname === "/"
        ? ["index.html"]
        : (() => {
            let decoded: string;
            try {
              decoded = decodeURIComponent(pathname);
            } catch {
              return null;
            }
            if (decoded.includes("\0") || decoded.includes("\\")) return null;
            if (!decoded.startsWith("/")) return null;
            const parts = decoded.slice(1).split("/");
            // No empty, dot, or parent segments at any depth, decoded or not.
            return parts.some(
              (part) => part === "" || part === "." || part === "..",
            )
              ? null
              : parts;
          })();
    if (!segments) return false;
    const target = resolve(this.webRoot, ...segments);
    // Containment is already implied by the segment rules; resolve + prefix is
    // belt-and-braces for platform quirks.
    if (target !== this.webRoot && !target.startsWith(`${this.webRoot}${sep}`))
      return false;
    const info = await stat(target).catch(() => null);
    if (info === null) return false;
    if (!info.isFile() || info.size > MAX_STATIC_FILE_BYTES) return false;
    // realpath guards against symlinks inside webRoot pointing outside it.
    if (!(await realpath(target)).startsWith(`${this.webRoot}${sep}`))
      return false;
    const type =
      STATIC_CONTENT_TYPES[extname(target).toLowerCase()] ??
      "application/octet-stream";
    response.statusCode = 200;
    response.setHeader("Content-Type", type);
    response.setHeader("Cache-Control", "no-store");
    if (headOnly) {
      response.end();
      return true;
    }
    response.end(await readFile(target));
    return true;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.on("error", () => {});
    try {
      const method = request.method ?? "";
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        this.fail(response, 400, "Invalid request path");
        return;
      }
      // Static assets carry no Run data and precede the token gate; every
      // non-file path keeps the original 401/404 data-only behavior.
      if (
        method === "GET" &&
        (await this.serveStatic(pathname, response, false))
      )
        return;
      if (
        method === "HEAD" &&
        (await this.serveStatic(pathname, response, true))
      )
        return;
      if (!this.authorized(request.headers.authorization)) {
        this.fail(response, 401, "Unauthorized");
        return;
      }
      if (method === "GET" && pathname === "/runs")
        return await this.project(
          response,
          this.transport.request({ method: "list" }),
        );
      // Read-only connection catalog projection; the daemon decides between
      // the entry list and the structured not-enabled error, so the socket
      // protocol stays the single source of both shapes.
      if (method === "GET" && pathname === "/connections")
        return await this.project(
          response,
          this.transport.request({ method: "connections" }),
        );
      // Connection catalog write (same --catalog opt-in as the read): the
      // body is one profile JSON object, validated inside the service exactly
      // like start bodies.
      if (method === "POST" && pathname === "/connections")
        return await this.addConnection(request, response);
      const connection = pathname.match(/^\/connections\/([^/]+)$/);
      if (method === "PUT" && connection)
        return await this.updateConnection(
          request,
          response,
          connection[1] ?? "",
        );
      if (method === "DELETE" && connection) {
        // One path segment, percent-decoded. Unlike run ids, catalog ids have
        // no pattern: parseProviderProfile accepts any non-empty string, so a
        // stricter check here would fork HTTP from the CLI write path and make
        // CLI-created ids (dots, spaces, Unicode, …) undeletable.
        let id: string;
        try {
          id = decodeURIComponent(connection[1] ?? "");
        } catch {
          this.fail(response, 400, "Invalid connection id");
          return;
        }
        if (id.length === 0) {
          this.fail(response, 400, "Invalid connection id");
          return;
        }
        // Drain and discard any body like the run actions; limit, timeout and
        // interrupts still apply.
        if ((await this.readRequestBody(request, response)) === undefined)
          return;
        return await this.project(
          response,
          this.transport.request({ method: "connections-remove", id }),
        );
      }
      if (method === "GET" && pathname === "/events")
        return this.events(response);
      if (method === "POST" && pathname === "/runs")
        return await this.start(request, response);
      const detail = pathname.match(
        /^\/runs\/([^/]+)(?:\/(cancel|resume|reconcile-budget|diff\/files|diff\/file|diff|evidence|artifact))?$/,
      );
      const runId = detail?.[1];
      const action = detail?.[2];
      if (runId && RUN_ID_PATTERN.test(runId)) {
        if (method === "GET" && !action)
          return await this.project(
            response,
            this.transport.request({ method: "status", runId }),
          );
        if (method === "GET" && (action === "diff" || action === "evidence"))
          return await this.project(
            response,
            this.transport.request({ method: action, runId }),
          );
        if (method === "GET" && action === "diff/file") {
          const query = new URL(request.url ?? "/", "http://127.0.0.1");
          const path = query.searchParams.get("path");
          const mode = query.searchParams.get("mode");
          if (path === null || mode === null) {
            this.fail(response, 400, "diff file query requires path and mode");
            return;
          }
          // Values are validated inside the service, exactly like start bodies.
          return await this.project(
            response,
            this.transport.request({
              method: "diff-file",
              runId,
              path,
              mode: mode as "working" | "staged",
            }),
          );
        }
        if (method === "GET" && action === "artifact") {
          const query = new URL(request.url ?? "/", "http://127.0.0.1");
          const evidenceId = query.searchParams.get("evidence");
          if (evidenceId === null) {
            this.fail(response, 400, "artifact query requires evidence");
            return;
          }
          // Values are validated inside the service, exactly like start bodies.
          return await this.project(
            response,
            this.transport.request({ method: "artifact", runId, evidenceId }),
          );
        }
        if (method === "GET" && action === "diff/files") {
          const query = new URL(request.url ?? "/", "http://127.0.0.1");
          const after = query.searchParams.get("after");
          const limit = query.searchParams.get("limit");
          // Pure decimal integer literal only. Number()'s loose parsing would
          // let "5e1"/"0x10"/"+5"/" 5" reach the daemon's 1-200 range check as
          // valid numbers; the HTTP query keeps the stricter start-body shape.
          if (limit !== null && !/^[0-9]+$/.test(limit)) {
            this.fail(response, 400, "Invalid diff files limit");
            return;
          }
          return await this.project(
            response,
            this.transport.request({
              method: "diff-files",
              runId,
              ...(after === null ? {} : { after }),
              ...(limit === null ? {} : { limit: Number(limit) }),
            }),
          );
        }
        if (
          method === "POST" &&
          (action === "cancel" ||
            action === "resume" ||
            action === "reconcile-budget")
        ) {
          if ((await this.readRequestBody(request, response)) === undefined)
            return; // drain and discard; limit, timeout and interrupts still enforced
          return await this.project(
            response,
            this.transport.request({ method: action, runId }),
          );
        }
      }
      this.fail(response, 404, "Not found");
    } catch (error) {
      this.fail(
        response,
        500,
        error instanceof Error ? error.message : "HTTP projection failed",
      );
    }
  }

  /** POST /connections: body is one non-secret profile JSON object; every
   * field rule (allowed field set, required strings, optional types, no
   * credential fields) is validated inside the service via
   * parseProviderProfile, exactly like start bodies. */
  private async addConnection(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readRequestBody(request, response);
    if (body === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      this.fail(response, 400, "Invalid JSON body");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail(response, 400, "Connection body requires a profile object");
      return;
    }
    await this.project(
      response,
      this.transport.request({
        method: "connections-add",
        profile: parsed as ProviderProfile,
      }),
    );
  }

  /** PUT /connections/:id: update one catalog entry. The id segment follows
   * the DELETE contract (single path segment, percent-decoded, non-empty,
   * deliberately not pattern-checked so CLI-storable ids stay writable). The
   * body is one non-secret profile JSON object validated inside the service
   * exactly like POST bodies, and its id must equal the path id: an update is
   * an explicit same-id replacement, never an upsert and never an implicit
   * rename. */
  private async updateConnection(
    request: IncomingMessage,
    response: ServerResponse,
    segment: string,
  ): Promise<void> {
    let id: string;
    try {
      id = decodeURIComponent(segment);
    } catch {
      this.fail(response, 400, "Invalid connection id");
      return;
    }
    if (id.length === 0) {
      this.fail(response, 400, "Invalid connection id");
      return;
    }
    const body = await this.readRequestBody(request, response);
    if (body === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      this.fail(response, 400, "Invalid JSON body");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail(response, 400, "Connection body requires a profile object");
      return;
    }
    if ((parsed as { id?: unknown }).id !== id) {
      this.fail(response, 400, "Connection body id must match the path id");
      return;
    }
    await this.project(
      response,
      this.transport.request({
        method: "connections-update",
        profile: parsed as ProviderProfile,
      }),
    );
  }

  private async start(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readRequestBody(request, response);
    if (body === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      this.fail(response, 400, "Invalid JSON body");
      return;
    }
    const { spec, profile } = (parsed ?? {}) as {
      spec?: unknown;
      profile?: unknown;
    };
    if (
      !spec ||
      typeof spec !== "object" ||
      !profile ||
      typeof profile !== "object"
    ) {
      this.fail(response, 400, "Start body requires spec and profile objects");
      return;
    }
    await this.project(
      response,
      this.transport.request({
        method: "start",
        spec: spec as FeatureSpec,
        profile: profile as ProviderProfile,
      }),
    );
  }

  private events(response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.flushHeaders();
    const stream: EventStream = { response, timer: undefined };
    this.streams.add(stream);
    let snapshot = "";
    const finish = () => {
      if (stream.timer) clearTimeout(stream.timer);
      this.streams.delete(stream);
    };
    response.on("close", finish);
    // Non-overlapping snapshot polling (TUI cadence): pushes on any RunSummary
    // diff, so step progress landing in Run DBs projects without new hooks.
    const poll = async () => {
      if (response.destroyed || response.writableEnded) return;
      let runs: RunSummary[];
      try {
        runs = (await this.transport.request({
          method: "list",
        })) as RunSummary[];
      } catch {
        finish();
        response.end();
        return;
      }
      if (response.destroyed || response.writableEnded) return;
      const next = JSON.stringify(runs);
      if (next !== snapshot) {
        snapshot = next;
        response.write(`data: ${next}\n\n`);
      }
      stream.timer = setTimeout(() => void poll(), this.pollIntervalMs);
    };
    void poll();
  }
}
