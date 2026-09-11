export interface AgentRunEvent {
  threadId: string;
  turnId: string;
  type: "progress" | "warning" | "result";
  message: string;
}

export interface CandidateRevisionFileChange {
  path: string;
  operation: "add" | "modify";
  parentBlobSha: string | null;
  resultBlobSha?: string;
}

export interface AgentRunRequest {
  runId: string;
  threadId: string;
  turnId: string;
  workItemId: string;
  planRevision: number;
  nodeId: string;
  cwd: string;
  /** Host-locked immutable source, never inferred from the provider's current HEAD. */
  sourceSha?: string;
  /** Exact host-authorized parent-to-child delta, absent for ordinary execution. */
  allowedChanges?: readonly CandidateRevisionFileChange[];
  /** Trusted host-only gate, never serialized into worker or model task data. */
  assertAuthorityCurrent?(): void;
  objective: string;
  instructions: string;
  inputEvidence: string[];
  /** Host-derived current Spec; absent only for legacy/direct provider adapters. */
  requirementSpec?: import("./execution-spec.ts").ExecutionRequirementSpec;
  readScope: string[];
  writeScope: string[];
  denyScope: string[];
  expectedArtifacts: string[];
  completionDefinition: string;
  environment: NodeJS.ProcessEnv;
  capabilities: {
    network: false;
    dependencyInstallation: false;
    arbitraryCommands: false;
    gitCommit: false;
  };
  sandbox: {
    filesystemRoot: string;
    readOnlyPaths: string[];
    denyGitMetadata: true;
    network: "deny";
  };
  containmentBinding: import("./containment.ts").ContainmentBinding;
  signal: AbortSignal;
  /** Register as soon as the backend creates its independently verifiable containment. */
  registerContainment(proof: import("./containment.ts").ContainmentProof): Promise<void>;
  emit(event: AgentRunEvent): void;
}

export interface AgentRunResult {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "needs_configuration";
  message?: string;
  need?: "network" | "dependency_installation" | "provider_source_unavailable";
  sandboxEnforced: boolean;
  /** Required before candidate output can cross the runtime trust boundary. */
  containmentProof?: import("./containment.ts").ContainmentProof;
}

export interface AgentRunPort {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  /** Must stop and reap the provider process tree before resolving. */
  interrupt(runId: string): Promise<void>;
}

export function eventBelongsToRun(
  event: AgentRunEvent,
  identity: { threadId: string; turnId: string },
): boolean {
  return event.threadId === identity.threadId && event.turnId === identity.turnId;
}
