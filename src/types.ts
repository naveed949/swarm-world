export type Vec2 = Readonly<{ x: number; y: number }>;
export type ResourceId =
  | "CELLULOSE"
  | "CHITIN"
  | "MINERAL"
  | "FUNGAL"
  | "CATALYST"
  | "KELP"
  | "SHELL"
  | "LIGNIN";
export type FieldId =
  | "temperature"
  | "water"
  | "stability"
  | "contamination"
  | "solar"
  | "nutrients";
export type FacilityId =
  "WASH" | "DRY" | "CROSSLINK" | "FERMENT" | "ALIGN" | "MINERALIZE";
export type ServiceId =
  "water" | "remediation" | "stability" | "healing" | "nutrient";
export type Condition =
  "full" | "no-communication" | "no-explicit-culture" | "independent";

export interface ResearchState {
  goal: string;
  hypothesis: string;
  progress: string;
  nextCheckpoint: string;
  collaborationNeed: string;
}

export interface MaterialProperties {
  stiffness: number;
  toughness: number;
  permeability: number;
  adhesion: number;
  healing: number;
  responsiveness: number;
  degradation: number;
}

export interface Recipe {
  inputs: Partial<Record<ResourceId, number>>;
  operations: FacilityId[];
  hydration: number;
  porosity: number;
  alignment: number;
  crosslinking: number;
}

export interface MaterialBatch {
  id: string;
  ownerId: string;
  recipe: Recipe;
  properties: MaterialProperties;
  quality: number;
  tested: boolean;
  contributors: string[];
  evidenceIds: string[];
}

export interface PendingBatch {
  id: string;
  ownerId: string;
  recipe: Recipe;
  nextOperationIndex: number;
  contributors: string[];
  evidenceIds: string[];
}

export type Sensor =
  | FieldId
  | "health"
  | "maturity"
  | "storage"
  | "reserve"
  | "opening"
  | "stiffness"
  | "toughness"
  | "permeability"
  | "adhesion"
  | "healing"
  | "responsiveness"
  | "degradation";
export type Op =
  | "CONST"
  | "SENSOR"
  | "COPY"
  | "ADD"
  | "SUB"
  | "MUL"
  | "MIN"
  | "MAX"
  | "GT"
  | "LT"
  | "ACT";
export type Actuator =
  | "COLLECT_WATER"
  | "GROW"
  | "HEAL"
  | "SET_OPENING"
  | "REMEDIATE"
  | "EMIT_SIGNAL";
export interface Instruction {
  op: Op;
  dst?: number;
  a?: number;
  b?: number;
  value?: number;
  sensor?: Sensor;
  actuator?: Actuator;
}
export interface ArtifactProgram {
  id: string;
  instructions: Instruction[];
  authorId: string;
  parentId?: string;
}

export interface ArtifactSpec {
  name: string;
  claimedFunction: string;
  architecture: string;
  bioInspiration: string[];
  predictedEffects: string[];
  geometry: { area: number; thickness: number; channels: number };
}

export interface Artifact {
  id: string;
  position: Vec2;
  creatorId: string;
  contributors: string[];
  batchId: string;
  properties: MaterialProperties;
  spec?: ArtifactSpec;
  health: number;
  maturity: number;
  storage: number;
  reserve: number;
  opening: number;
  signal: number;
  active: boolean;
  programId?: string;
  programHistory: string[];
  peakPerformance: number;
  lastServices: Record<ServiceId, number>;
}

export interface MemoryRecord {
  id: string;
  tick: number;
  kind: string;
  text: string;
  evidenceIds: string[];
}
export interface AgentState {
  id: string;
  position: Vec2;
  phase: number;
  inventory: Partial<Record<ResourceId, number>>;
  batches: MaterialBatch[];
  pendingBatches: PendingBatch[];
  queue: Action[];
  research: ResearchState;
  memory: MemoryRecord[];
  observedCells: Map<string, number>;
  observedPrograms: Set<string>;
  authoredPrograms: Set<string>;
  inheritedPrograms: Set<string>;
  pendingMessages: string[];
  active: boolean;
}

export interface Message {
  id: string;
  tick: number;
  senderId: string;
  recipientId?: string;
  position: Vec2;
  text: string;
  replyTo?: string;
}
export interface Publication {
  id: string;
  tick: number;
  authorId: string;
  title: string;
  body: string;
  evidenceIds: string[];
}

export type Action =
  | { type: "WAIT" }
  | { type: "MOVE"; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { type: "INSPECT"; target: "CELL" | "ARTIFACT"; artifactId?: string }
  | { type: "HARVEST"; resource: ResourceId; amount: number }
  | { type: "DEPOSIT"; resource: ResourceId; amount: number }
  | { type: "WITHDRAW"; resource: ResourceId; amount: number }
  | { type: "FORMULATE"; recipe: Recipe }
  | { type: "PROCESS"; pendingBatchId: string }
  | { type: "TEST"; batchId: string }
  | { type: "CONSTRUCT"; batchId: string; spec: ArtifactSpec }
  | {
      type: "INSTALL_PROGRAM";
      artifactId: string;
      instructions: Instruction[];
      parentId?: string;
    }
  | { type: "FORK_PROGRAM"; programId: string; instructions: Instruction[] }
  | { type: "REPAIR"; artifactId: string; amount: number }
  | { type: "DISMANTLE"; artifactId: string }
  | {
      type: "COMMUNICATE";
      text: string;
      recipientId?: string;
      replyTo?: string;
    }
  | { type: "PUBLISH"; title: string; body: string; evidenceIds: string[] }
  | {
      type: "TEACH";
      recipientId: string;
      text: string;
      recordIds: string[];
      programIds: string[];
    }
  | { type: "TRADE"; recipientId: string; resource: ResourceId; amount: number }
  | { type: "CLAIM_TASK"; task: string };

export interface AgentPlan {
  research: ResearchState;
  actions: Action[];
}
export interface LocalObservation {
  tick: number;
  self: {
    id: string;
    position: Vec2;
    inventory: AgentState["inventory"];
    batches: MaterialBatch[];
    pendingBatches: PendingBatch[];
  };
  cells: Array<{
    position: Vec2;
    terrain: string;
    resource?: { id: ResourceId; mass: number };
    facility?: FacilityId;
    fields: Record<FieldId, number>;
  }>;
  agents: Array<{ id: string; position: Vec2 }>;
  artifacts: Artifact[];
  messages: Message[];
  publications: Publication[];
  affordances: string[];
}

export interface EventRecord {
  id: string;
  tick: number;
  type: string;
  actorId?: string;
  targetId?: string;
  success: boolean;
  data: Record<string, unknown>;
  previousDigest: string;
  digest: string;
}

export interface ExperimentConfig {
  seed: number;
  population: number;
  ticks: number;
  macroturnInterval: number;
  planLimit: number;
  condition: Condition;
  cognition: "heuristic" | "pi";
  model: {
    provider: string;
    id: string;
    temperature: number;
    reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  world: {
    width: number;
    height: number;
    observationRadius: number;
    inventoryLimit: number;
    disturbanceInterval: number;
    disturbanceIntensity: number;
    scenarioPackage?: string;
    scenario?: ScenarioPackage;
  };
  evaluation: { checkpoints: number[]; ticks: number; seeds: number[] };
}

export type Shape =
  | {
      kind: "circle" | "ellipse";
      center: [number, number];
      radius: number | [number, number];
    }
  | { kind: "rectangle"; bounds: [number, number, number, number] };
export interface ScenarioPackage {
  formatVersion: 1;
  id: string;
  name: string;
  version: string;
  sourceHash: string;
  baseTerrain: string;
  features: Array<{ terrain: string; shape: Shape }>;
  deposits: Array<{
    resource: ResourceId;
    shape: Shape;
    capacity: number;
    capacityVariation: number;
    initialFill: [number, number];
    renewal: number;
  }>;
  facilityPlacements: Array<{
    facility: FacilityId;
    position: [number, number];
  }>;
  fieldInitial: Partial<Record<FieldId, number>>;
}

export interface Capabilities {
  sharedWorld: boolean;
  communication: boolean;
  publication: boolean;
  teaching: boolean;
  trade: boolean;
  taskClaims: boolean;
  authoredText: boolean;
  crossAgentPrograms: boolean;
  programForking: boolean;
}

export interface FrozenWorld {
  tick: number;
  world: WorldSnapshot;
  artifacts: Artifact[];
  programs: ArtifactProgram[];
}

export interface WorldSnapshot {
  width: number;
  height: number;
  terrain: string[];
  resourceType: Array<ResourceId | null>;
  resourceMass: number[];
  resourceCapacity: number[];
  resourceRenewal: number[];
  facilities: Array<FacilityId | null>;
  fields: Record<FieldId, number[]>;
  depots: Array<Partial<Record<ResourceId, number>>>;
}

export interface EvaluationResult {
  seed: number;
  resilienceAuc: number;
  serviceAuc: Record<ServiceId, number>;
  finalCoverage: Record<ServiceId, number>;
}
export interface RunSummary {
  runId: string;
  configHash: string;
  traceHash: string;
  events: number;
  artifacts: number;
  programs: number;
  discoveryFrontierAuc: number;
  bestArtifactPerformance: number;
  evaluations: Record<number, EvaluationResult[]>;
}
