import { createConnection } from "node:net";
import type { ProviderProfile } from "../providers/index.js";
import type { Evidence } from "../workflow/index.js";
import type { RunSummary } from "./catalog.js";
import type {
  BudgetReconciliation,
  ConnectionWriteResult,
  RunArtifact,
  RunDiff,
  RunDiffFile,
  RunDiffFilePage,
  ServiceRequest,
} from "./daemon.js";

export class ServiceClient {
  constructor(readonly socketPath: string) {}
  request(request: { method: "list" }): Promise<RunSummary[]>;
  request(request: { method: "connections" }): Promise<ProviderProfile[]>;
  request(request: {
    method: "connections-add";
    profile: ProviderProfile;
  }): Promise<ConnectionWriteResult>;
  request(request: {
    method: "connections-update";
    profile: ProviderProfile;
  }): Promise<ConnectionWriteResult>;
  request(request: {
    method: "connections-remove";
    id: string;
  }): Promise<ConnectionWriteResult>;
  request(request: { method: "diff"; runId: string }): Promise<RunDiff>;
  request(request: {
    method: "artifact";
    runId: string;
    evidenceId: string;
  }): Promise<RunArtifact>;
  request(request: {
    method: "diff-file";
    runId: string;
    path: string;
    mode: "working" | "staged";
  }): Promise<RunDiffFile>;
  request(request: {
    method: "diff-files";
    runId: string;
    after?: string;
    limit?: number;
  }): Promise<RunDiffFilePage>;
  request(request: { method: "evidence"; runId: string }): Promise<Evidence[]>;
  request(request: {
    method: "reconcile-budget";
    runId: string;
  }): Promise<BudgetReconciliation>;
  request(
    request: Exclude<
      ServiceRequest,
      {
        method:
          | "list"
          | "connections"
          | "connections-add"
          | "connections-update"
          | "connections-remove"
          | "diff"
          | "artifact"
          | "diff-file"
          | "diff-files"
          | "evidence"
          | "reconcile-budget";
      }
    >,
  ): Promise<RunSummary>;
  request(
    request: ServiceRequest,
  ): Promise<
    | RunSummary
    | RunSummary[]
    | ProviderProfile[]
    | ConnectionWriteResult
    | RunDiff
    | RunArtifact
    | RunDiffFile
    | RunDiffFilePage
    | Evidence[]
    | BudgetReconciliation
  > {
    return new Promise((accept, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let body = "";
      let settled = false;
      const finish = (
        error?: Error,
        result?:
          | RunSummary
          | RunSummary[]
          | ProviderProfile[]
          | ConnectionWriteResult
          | RunDiff
          | RunArtifact
          | RunDiffFile
          | RunDiffFilePage
          | Evidence[]
          | BudgetReconciliation,
      ) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else if (result) accept(result);
      };
      socket.setTimeout(60_000, () =>
        finish(
          new Error(
            "Service request timed out; acceptance may already be persisted",
          ),
        ),
      );
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("error", (error) => finish(error));
      socket.on("close", () =>
        finish(
          new Error(
            "Service disconnected before response; acceptance may already be persisted",
          ),
        ),
      );
      socket.on("data", (chunk) => {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) {
          finish(new Error("Service response too large"));
          return;
        }
        if (!body.includes("\n")) return;
        try {
          const response = JSON.parse(body.slice(0, body.indexOf("\n"))) as {
            ok: boolean;
            result?:
              | RunSummary
              | RunSummary[]
              | ProviderProfile[]
              | ConnectionWriteResult
              | RunDiff
              | RunArtifact
              | RunDiffFile
              | RunDiffFilePage
              | Evidence[]
              | BudgetReconciliation;
            error?: string;
          };
          if (!response.ok || response.result === undefined)
            finish(new Error(response.error ?? "Service request failed"));
          else finish(undefined, response.result);
        } catch {
          finish(new Error("Invalid service response"));
        }
      });
    });
  }
}
