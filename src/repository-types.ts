import type { Condition } from "./types.js";

export type RepositoryNodeType =
  | "task"
  | "problem"
  | "task_proposal"
  | "commitment"
  | "verification"
  | "file"
  | "symbol"
  | "module"
  | "test"
  | "diagnostic"
  | "facility"
  | "pending_patch"
  | "accepted_artifact";

export type RepositoryEdgeType =
  | "containment"
  | "import"
  | "call"
  | "test_relation"
  | "task_relevance"
  | "ownership"
  | "change_coupling"
  | "artifact_ancestry";

export interface RepositoryNode {
  id: string;
  type: RepositoryNodeType;
  label: string;
  path?: string;
  contentHash?: string;
}

export interface RepositoryEdge {
  from: string;
  to: string;
  type: RepositoryEdgeType;
}

export interface RepositoryTask {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  acceptanceFacilityIds: string[];
  regressionFacilityIds: string[];
  relevantPaths: string[];
  priority: number;
}

export interface RepositoryGoal {
  id: string;
  statement: string;
  success: {
    requiredTaskIds?: string[] | undefined;
    minimumEligibleArtifacts?: number | undefined;
    mandatoryChecksPass?: boolean | undefined;
  };
  budget: {
    maxActions: number;
    maxVerificationRuns: number;
    maxWrites: number;
    maxAttempts: number;
    maxModelCalls?: number | undefined;
  };
  stop: {
    successSustainedForCheckpoints: number;
    noProgressTicks: number;
    checkpointInterval: number;
  };
}

export interface RepositoryProblem {
  id: string;
  authorAgentId: string;
  statement: string;
  evidenceIds: string[];
  goalImpact: string;
  status: "proposed" | "confirmed" | "challenged" | "resolved";
  confirmations: string[];
  challenges: Array<{ agentId: string; evidenceIds: string[]; reason: string }>;
}

export interface RepositoryTaskProposal extends RepositoryTask {
  problemId: string;
  authorAgentId: string;
  objective: string;
  expectedOutcome: string;
  dependencies: string[];
  verificationPlan: string[];
  estimatedCost: number;
  status: "proposed" | "admitted" | "rejected" | "resolved";
}

export interface RepositoryCommitment {
  id: string;
  agentId: string;
  taskId: string;
  approach: string;
  roleLabel: string;
  intendedContribution: string;
  exitCondition: string;
  createdAtTick: number;
  leaseExpiresAtTick: number;
  status: "active" | "released" | "expired" | "completed";
}

export interface RepositoryVerification {
  id: string;
  artifactId: string;
  verifierAgentId: string;
  facilityId: string;
  success: boolean;
  outputDigest: string;
  revision: string;
  facilityPolicyHash: string;
  recommendation: "accept" | "revise" | "reject";
}

export interface RepositorySelection {
  id: string;
  selectedArtifactId: string;
  eligibleArtifactIds: string[];
  rejected: Array<{ artifactId: string; reason: string }>;
  score: {
    passedFacilities: number;
    taskCoverage: number;
    changedLines: number;
  };
}

export interface RepositoryFacility {
  id: string;
  category:
    "format" | "build" | "test" | "typecheck" | "lint" | "analysis" | "hidden";
  executable: string;
  args: string[];
  workingDirectory: string;
  permittedPaths: string[];
  mutationClass: "none" | "worktree";
  sandbox?: { executable: string; args: string[] };
  timeoutMs: number;
  outputLimit: number;
  concurrency: number;
  environment: Record<string, string>;
  mandatory: boolean;
}

export interface RepositoryEnvironmentConfig {
  root: string;
  baseCommit: string;
  readOnly?: boolean;
  condition?: Condition;
  task: RepositoryTask;
  goal?: RepositoryGoal;
  observationRadius: number;
  observationLimit: number;
  allowedPaths: string[];
  excludedPaths: string[];
  patch: { maxFiles: number; maxChangedLines: number };
  facilities: RepositoryFacility[];
}

export type RepositoryAction =
  | { type: "WAIT" }
  | { type: "FOCUS"; nodeId: string }
  | { type: "INSPECT"; nodeId: string }
  | { type: "SEARCH"; query: string; paths?: string[] }
  | { type: "CLAIM_TASK"; taskId: string }
  | {
      type: "PROPOSE_PROBLEM";
      statement: string;
      evidenceIds: string[];
      goalImpact: string;
    }
  | { type: "CONFIRM_PROBLEM"; problemId: string; evidenceIds: string[] }
  | {
      type: "CHALLENGE_PROBLEM";
      problemId: string;
      evidenceIds: string[];
      reason: string;
    }
  | {
      type: "PROPOSE_TASK";
      problemId: string;
      objective: string;
      expectedOutcome: string;
      relevantPaths: string[];
      acceptanceCriteria: string[];
      acceptanceFacilityIds: string[];
      regressionFacilityIds: string[];
      dependencies: string[];
      verificationPlan: string[];
      estimatedCost: number;
    }
  | {
      type: "DECOMPOSE_TASK";
      taskId: string;
      objective: string;
      relevantPaths: string[];
      verificationPlan: string[];
      estimatedCost: number;
    }
  | {
      type: "CLAIM_COMMITMENT";
      taskId: string;
      approach: string;
      roleLabel: string;
      intendedContribution: string;
      exitCondition: string;
      leaseTicks: number;
    }
  | {
      type: "JOIN_COMMITMENT";
      commitmentId: string;
      roleLabel: string;
      leaseTicks: number;
    }
  | { type: "RELEASE_COMMITMENT"; commitmentId: string }
  | { type: "COMMUNICATE"; recipientId: string; text: string }
  | { type: "TEACH_ARTIFACT"; recipientId: string; artifactId: string }
  | {
      type: "FORMULATE";
      taskId: string;
      evidenceIds: string[];
      targets: string[];
      requiredFacilities: string[];
    }
  | {
      type: "EDIT";
      recipeId: string;
      path: string;
      expectedContentHash: string;
      content: string;
    }
  | {
      type: "EDIT_REPLACE";
      recipeId: string;
      path: string;
      expectedContentHash: string;
      oldText: string;
      newText: string;
    }
  | { type: "RUN_CHECK"; recipeId: string; facilityId: string }
  | { type: "CONSTRUCT_ARTIFACT"; recipeId: string }
  | { type: "REQUEST_VERIFICATION"; artifactId: string }
  | { type: "VERIFY_ARTIFACT"; artifactId: string; facilityId: string }
  | {
      type: "CHALLENGE_VERIFICATION";
      verificationId: string;
      evidenceIds: string[];
      reason: string;
    }
  | { type: "RECOMMEND_CANDIDATE"; artifactId: string }
  | {
      type: "PUBLISH_FINDING";
      title: string;
      body: string;
      evidenceIds: string[];
    }
  | { type: "REQUEST_INTEGRATION"; artifactId: string };

export interface RepositoryObservation {
  revision: string;
  focusNodeId: string;
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
  ownedEvidenceIds: string[];
  inspectedNodeIds: string[];
  ownedEvidence: Array<{
    id: string;
    kind: string;
    digest: string;
    data: Record<string, unknown>;
  }>;
  ownedRecipeIds: string[];
  ownedRecipes: Array<{
    id: string;
    targets: string[];
    targetContentHashes: Record<string, string>;
    requiredFacilityIds: string[];
    patchHash: string;
    passedFacilityIds: string[];
    failedFacilityIds: string[];
  }>;
  ownedArtifactIds: string[];
  goal?: RepositoryGoal;
  problems?: RepositoryProblem[];
  taskProposals?: RepositoryTaskProposal[];
  commitments?: RepositoryCommitment[];
  candidates?: Array<{
    artifactId: string;
    authorId: string;
    taskIds: string[];
    patchHash: string;
    verificationFacilityIds: string[];
    verificationRequested: boolean;
    eligible: boolean;
  }>;
  verifications?: RepositoryVerification[];
  selection?: RepositorySelection;
  taskClaims: Array<{ taskId: string; agentId: string }>;
  messages: Array<{ senderId: string; recipientId: string; text: string }>;
  findings: Array<{
    id: string;
    authorId: string;
    title: string;
    body: string;
    evidenceIds: string[];
  }>;
  inheritedArtifactIds: string[];
  affordances: RepositoryAction["type"][];
  budgets: {
    context: number;
    actions: number;
    verification: number;
    writes: number;
    globalActions?: number;
    globalVerification?: number;
    globalWrites?: number;
    attempts?: number;
  };
}

export interface RepositoryArtifact {
  id: string;
  commit: string;
  baseCommit: string;
  parentArtifacts: string[];
  authorId: string;
  contributors: string[];
  taskIds: string[];
  touchedNodes: string[];
  patchHash: string;
  evidenceIds: string[];
  priority: number;
  approach?: string;
  hypothesis?: string;
  changedLines?: number;
  status?: "submitted" | "eligible" | "rejected" | "accepted" | "superseded";
}

export interface RepositoryFrozenSnapshot {
  candidateCommit: string;
  baseCommit: string;
  graphHash: string;
  facilityPolicyHash: string;
  traceHash: string;
  acceptedArtifacts: RepositoryArtifact[];
  task: RepositoryTask;
  goal?: RepositoryGoal;
  selection?: RepositorySelection;
  problems: RepositoryProblem[];
  taskProposals: RepositoryTaskProposal[];
}

export interface RepositoryEvaluation {
  outcome:
    | "completed"
    | "no eligible artifact"
    | "needs clarification"
    | "budget exhausted"
    | "permission blocked"
    | "conflict unresolved"
    | "evaluation inconclusive";
  revision: string;
  hardGatesPassed: boolean;
  checks: Array<{
    facilityId: string;
    success: boolean;
    outputDigest: string;
    revision: string;
    facilityPolicyHash: string;
    executionEnvironment: string;
  }>;
  correctness: number;
  regressionSafety: number;
  issueCoverage: number;
  maintainability: number;
  robustness: number;
}

export interface RepositoryAgent {
  id: string;
  focusNodeId: string;
  evidence: Set<string>;
  observedNodes: Set<string>;
  inheritedArtifacts: Set<string>;
  actionsRemaining: number;
  verificationRemaining: number;
  writesRemaining: number;
}

export interface RepositoryEvidence {
  id: string;
  ownerId: string;
  kind: string;
  revision: string;
  digest: string;
  data: Record<string, unknown>;
}

export interface RepositoryRecipe {
  id: string;
  ownerId: string;
  taskId: string;
  evidenceIds: string[];
  targets: string[];
  requiredFacilities: string[];
  worktree: string;
  baseCommit: string;
  patchHash: string;
  checks: Map<string, string>;
  invalid?: boolean;
}

export interface RepositoryTraceEvent {
  sequence: number;
  type: string;
  accepted: boolean;
  actorId?: string;
  targetId?: string;
  data: Record<string, unknown>;
  previousDigest: string;
  digest: string;
}
