import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { apply } from "@earendil-works/chord/delta";
import {
  defineDoc,
  type JsonObject,
  type Session,
} from "@earendil-works/pi-durable";
import type { WorkspaceRecord } from "../workspace/manager.js";
import {
  createWorkflowRun,
  WorkflowDoc,
  type WorkflowRun,
  type WorkspaceIdentity,
  workflowTemplate,
} from "./index.js";

export type FeatureSpec = {
  runId: string;
  goal: string;
  repositoryPath: string;
  baseCommit: string;
  worktreePath: string;
  targeted: string[];
  regression: string[];
};
export type FeatureArtifact = {
  id: string;
  stepId: string;
  body: string;
};
export type FeatureState = {
  spec: FeatureSpec;
  workspace: { [K in keyof WorkspaceRecord]: WorkspaceRecord[K] };
  artifacts: FeatureArtifact[];
  operation: {
    id: string;
    stepId: string;
    conversationId: string | null;
  } | null;
  reviewReworks?: number;
  /** Verification repair attempts across targeted and regression checks. */
  verificationReworks?: number;
  reconciliations?: {
    operationId: string;
    stepId: string;
    workspace: WorkspaceIdentity;
    recordedAt: number;
  }[];
  blockedReason: string | null;
};
const FeatureDoc = defineDoc<{ state: FeatureState | null }>({
  kind: "loom.feature.driver",
  version: 1,
  scope: "session",
  initial: () => ({ state: null }),
});

export function validateFeatureSpec(value: FeatureSpec): void {
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.runId) ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    value.goal.length > 16000 ||
    ![value.repositoryPath, value.worktreePath, value.baseCommit].every(
      (item) => typeof item === "string" && item.length > 0,
    ) ||
    ![value.targeted, value.regression].every(
      (argv) =>
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.length <= 64 &&
        argv.every(
          (item) => typeof item === "string" && !item.includes("\0"),
        ) &&
        Boolean(argv[0]?.trim()),
    )
  )
    throw new Error("Invalid feature spec");
}

/** Host-only capability. Model output never receives this store or dispatches evidence. */
export class FeatureStore {
  constructor(private readonly session: Pick<Session, "commit" | "snapshot">) {}

  async initialize(
    spec: FeatureSpec,
    workspace: WorkspaceRecord,
    identity: WorkspaceIdentity,
    allowCreate = true,
  ): Promise<void> {
    await this.session.commit(async (tx) => {
      const feature = await tx.doc(FeatureDoc);
      const workflow = await tx.doc(WorkflowDoc);
      if (feature.state) {
        if (
          JSON.stringify(feature.state.spec) !== JSON.stringify(spec) ||
          JSON.stringify({ ...feature.state.workspace, head: "" }) !==
            JSON.stringify({ ...workspace, head: "" })
        )
          throw new Error("Feature configuration differs from persisted Run");
        return;
      }
      if (!allowCreate)
        throw new Error(
          "Bound Runtime has no feature state; reconciliation required",
        );
      if (workflow.run) throw new Error("Runtime already contains another Run");
      workflow.run = createWorkflowRun({
        id: spec.runId,
        goal: spec.goal,
        workspace: identity,
        template: workflowTemplate("feature"),
      });
      feature.state = {
        spec,
        workspace,
        artifacts: [],
        operation: null,
        reviewReworks: 0,
        verificationReworks: 0,
        reconciliations: [],
        blockedReason: null,
      };
    }, BACKGROUND_CONTEXT);
  }

  async update<T>(
    action: (state: FeatureState, run: WorkflowRun) => T,
  ): Promise<T> {
    return this.session.commit(async (tx) => {
      const feature = await tx.doc(FeatureDoc);
      const workflow = await tx.doc(WorkflowDoc);
      if (!feature.state || !workflow.run)
        throw new Error("Feature is not initialized");
      const state: FeatureState = JSON.parse(JSON.stringify(feature.state));
      const run: WorkflowRun = JSON.parse(JSON.stringify(workflow.run));
      const result = action(state, run);
      feature.state = state;
      workflow.run = run;
      return result;
    }, BACKGROUND_CONTEXT);
  }

  read(): Promise<{ state: FeatureState; run: WorkflowRun }> {
    return this.update((state, run) => ({ state, run }));
  }

  async inspect(): Promise<{ state: FeatureState; run: WorkflowRun } | null> {
    return FeatureStore.inspect(this.session);
  }

  static async inspect(
    session: Pick<Session, "snapshot">,
  ): Promise<{ state: FeatureState; run: WorkflowRun } | null> {
    const [feature, workflow] = await Promise.all([
      session.snapshot(FeatureDoc, BACKGROUND_CONTEXT),
      session.snapshot(WorkflowDoc, BACKGROUND_CONTEXT),
    ]);
    if (!feature?.state || !workflow?.run) return null;
    return structuredClone({ state: feature.state, run: workflow.run });
  }

  static inspectDatabase(database: DatabaseSync): {
    state: FeatureState;
    run: WorkflowRun;
  } | null {
    let began = false;
    database.exec("BEGIN");
    began = true;
    try {
      const feature = readSessionDocument(database, FeatureDoc) as
        | { state: FeatureState | null }
        | undefined;
      const workflow = readSessionDocument(database, WorkflowDoc) as
        | { run: WorkflowRun | null }
        | undefined;
      database.exec("COMMIT");
      if (!feature?.state || !workflow?.run) return null;
      return structuredClone({
        state: feature.state as FeatureState,
        run: workflow.run as WorkflowRun,
      });
    } catch (error) {
      if (began) database.exec("ROLLBACK");
      throw error;
    }
  }
}

function readSessionDocument(
  database: DatabaseSync,
  token: {
    definition: {
      kind: string;
      version: number;
      migrate?: (value: JsonObject, fromVersion: number) => JsonObject;
    };
  },
): unknown {
  const encodedKind = JSON.stringify(token.definition.kind);
  const row = database
    .prepare(
      "SELECT id, record FROM documents WHERE kind = ? AND family = 0 AND key_value = ? AND scope_kind = 'session' AND owner_id = 0 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(encodedKind, JSON.stringify("")) as
    | { id: number; record: string }
    | undefined;
  if (!row) return undefined;
  const record = JSON.parse(row.record);
  const base = database
    .prepare(
      "SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1",
    )
    .get(row.id) as
    | { seq: number; version: number; content: string }
    | undefined;
  if (!base) throw new Error(`Document ${row.id} is missing a required base`);
  let value: unknown = JSON.parse(base.content);
  const revisions = database
    .prepare(
      "SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq",
    )
    .all(row.id, base.seq) as {
    kind: string;
    version: number;
    content: string;
  }[];
  for (const revision of revisions) {
    if (revision.kind !== "delta" || revision.version !== base.version)
      throw new Error(`Document ${row.id} crosses a stored version boundary`);
    value = apply(value, JSON.parse(revision.content));
  }
  if (record.kind !== token.definition.kind)
    throw new Error(`Document ${row.id} kind does not match requested token`);
  const scope = record.scope as { kind?: unknown } | undefined;
  if (scope?.kind !== "session")
    throw new Error(`Document ${row.id} scope does not match requested token`);
  if (base.version > token.definition.version)
    throw new Error(
      `Document ${row.id} has newer version ${base.version} than supported`,
    );
  if (base.version < token.definition.version) {
    if (!token.definition.migrate)
      throw new Error(`Document ${row.id} requires migration`);
    value = token.definition.migrate(value as JsonObject, base.version);
  }
  return value;
}
