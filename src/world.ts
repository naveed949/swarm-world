import { Rng } from "./rng.js";
import type {
  AgentState,
  Artifact,
  FieldId,
  FacilityId,
  LocalObservation,
  Message,
  Publication,
  ResourceId,
  ScenarioPackage,
  Shape,
  Vec2,
  WorldSnapshot,
} from "./types.js";

const resources: ResourceId[] = [
  "CELLULOSE",
  "CHITIN",
  "MINERAL",
  "FUNGAL",
  "CATALYST",
  "KELP",
  "SHELL",
  "LIGNIN",
];
const facilities: FacilityId[] = [
  "WASH",
  "DRY",
  "CROSSLINK",
  "FERMENT",
  "ALIGN",
  "MINERALIZE",
];
const fields: FieldId[] = [
  "temperature",
  "water",
  "stability",
  "contamination",
  "solar",
  "nutrients",
];
const key = ({ x, y }: Vec2) => `${x},${y}`;
const clip = (x: number) => Math.max(0, Math.min(1, x));

export class World {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  terrain: string[];
  resourceType: Array<ResourceId | null>;
  resourceMass: number[];
  resourceCapacity: number[];
  resourceRenewal: number[];
  facilities: Array<FacilityId | null>;
  fields: Record<FieldId, number[]>;
  depots: Array<Partial<Record<ResourceId, number>>>;
  private rng: Rng;

  constructor(
    seed: number,
    width: number,
    height: number,
    snapshot?: WorldSnapshot,
    scenario?: ScenarioPackage,
  ) {
    this.seed = seed;
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
    const size = width * height;
    this.terrain = snapshot?.terrain ?? Array(size).fill("PLAIN");
    this.resourceType = snapshot?.resourceType ?? Array(size).fill(null);
    this.resourceMass = snapshot?.resourceMass ?? Array(size).fill(0);
    this.resourceCapacity = snapshot?.resourceCapacity ?? Array(size).fill(0);
    this.resourceRenewal = snapshot?.resourceRenewal ?? Array(size).fill(0.002);
    this.facilities = snapshot?.facilities ?? Array(size).fill(null);
    this.fields =
      snapshot?.fields ??
      (Object.fromEntries(
        fields.map((f) => [f, Array(size).fill(0)]),
      ) as Record<FieldId, number[]>);
    this.depots = snapshot?.depots ?? Array.from({ length: size }, () => ({}));
    if (!snapshot) this.generate(scenario);
  }

  index(p: Vec2): number {
    return p.y * this.width + p.x;
  }
  point(index: number): Vec2 {
    return { x: index % this.width, y: Math.floor(index / this.width) };
  }
  inside(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.height;
  }
  walkable(p: Vec2): boolean {
    return this.inside(p) && this.terrain[this.index(p)] !== "DEEP_WATER";
  }
  fieldAt(field: FieldId, p: Vec2): number {
    return this.fields[field][this.index(p)]!;
  }
  setField(field: FieldId, p: Vec2, value: number): void {
    this.fields[field][this.index(p)] = clip(value);
  }

  private generate(scenario?: ScenarioPackage): void {
    if (scenario) return this.generateScenario(scenario);
    const size = this.width * this.height;
    for (let i = 0; i < size; i++) {
      const p = this.point(i),
        nx = p.x / Math.max(1, this.width - 1),
        ny = p.y / Math.max(1, this.height - 1);
      this.terrain[i] =
        nx < 0.08 || (nx > 0.82 && ny < 0.18) ? "DEEP_WATER" : "PLAIN";
      this.fields.temperature[i] = clip(
        0.35 + 0.35 * nx + 0.05 * this.rng.next(),
      );
      this.fields.water[i] = clip(0.75 - 0.55 * nx + 0.08 * this.rng.next());
      this.fields.stability[i] = clip(
        0.55 + 0.25 * ny + 0.05 * this.rng.next(),
      );
      this.fields.contamination[i] = clip(0.03 * this.rng.next());
      this.fields.solar[i] = clip(0.45 + 0.35 * (1 - ny));
      this.fields.nutrients[i] = clip(0.35 + 0.3 * ny);
    }
    const centers = this.rng.shuffle(
      Array.from({ length: size }, (_, i) => i).filter((i) =>
        this.walkable(this.point(i)),
      ),
    );
    resources.forEach((resource, ri) => {
      const c = this.point(centers[ri]!);
      const radius = Math.max(
        2,
        Math.floor(Math.min(this.width, this.height) * 0.11),
      );
      for (
        let y = Math.max(0, c.y - radius);
        y <= Math.min(this.height - 1, c.y + radius);
        y++
      )
        for (
          let x = Math.max(0, c.x - radius);
          x <= Math.min(this.width - 1, c.x + radius);
          x++
        ) {
          const i = this.index({ x, y });
          if (!this.walkable({ x, y })) continue;
          const d = Math.hypot(x - c.x, y - c.y) / radius;
          if (d <= 1 && this.rng.next() < 0.75) {
            this.resourceType[i] = resource;
            this.resourceCapacity[i] = 2 + 2 * (1 - d);
            this.resourceMass[i] =
              this.resourceCapacity[i]! * this.rng.between(0.55, 0.9);
            this.terrain[i] = `${resource}_BIOME`;
          }
        }
    });
    facilities.forEach((facility, i) => {
      const cell = centers[resources.length + i]!;
      this.facilities[cell] = facility;
    });
    this.assertInvariants();
  }

  private matches(shape: Shape, p: Vec2): boolean {
    const x = p.x / Math.max(1, this.width - 1),
      y = p.y / Math.max(1, this.height - 1);
    if (shape.kind === "rectangle")
      return (
        x >= shape.bounds[0] &&
        y >= shape.bounds[1] &&
        x <= shape.bounds[2] &&
        y <= shape.bounds[3]
      );
    const radius: readonly [number, number] =
      typeof shape.radius === "number"
        ? [shape.radius, shape.radius]
        : shape.radius;
    return (
      ((x - shape.center[0]) / radius[0]) ** 2 +
        ((y - shape.center[1]) / radius[1]) ** 2 <=
      1
    );
  }

  private generateScenario(scenario: ScenarioPackage): void {
    const size = this.width * this.height;
    for (let i = 0; i < size; i++) {
      const p = this.point(i);
      this.terrain[i] = scenario.baseTerrain;
      for (const feature of scenario.features)
        if (this.matches(feature.shape, p)) this.terrain[i] = feature.terrain;
      for (const field of fields)
        this.fields[field][i] = scenario.fieldInitial[field] ?? 0;
    }
    for (const deposit of scenario.deposits)
      for (let i = 0; i < size; i++)
        if (
          this.walkable(this.point(i)) &&
          this.matches(deposit.shape, this.point(i))
        ) {
          const capacity =
            deposit.capacity *
            this.rng.between(
              1 - deposit.capacityVariation,
              1 + deposit.capacityVariation,
            );
          this.resourceType[i] = deposit.resource;
          this.resourceCapacity[i] = capacity;
          this.resourceMass[i] =
            capacity *
            this.rng.between(deposit.initialFill[0], deposit.initialFill[1]);
          this.resourceRenewal[i] = deposit.renewal;
        }
    for (const placement of scenario.facilityPlacements) {
      const requested = {
        x: Math.round(placement.position[0] * (this.width - 1)),
        y: Math.round(placement.position[1] * (this.height - 1)),
      };
      const target = this.walkable(requested)
        ? requested
        : Array.from({ length: size }, (_, i) => this.point(i))
            .filter((p) => this.walkable(p))
            .sort(
              (a, b) =>
                distanceSquared(a, requested) - distanceSquared(b, requested),
            )[0]!;
      const index = this.index(target);
      if (this.facilities[index])
        throw new Error(
          `Scenario facilities overlap at ${target.x},${target.y}`,
        );
      this.facilities[index] = placement.facility;
    }
    this.assertInvariants();
  }

  assertInvariants(): void {
    const walkable = this.terrain.filter((t) => t !== "DEEP_WATER").length;
    if (walkable < this.width * this.height * 0.6)
      throw new Error("World lacks sufficient walkable area");
    for (const resource of resources)
      if (!this.resourceType.includes(resource))
        throw new Error(`Missing resource ${resource}`);
    for (const facility of facilities)
      if (!this.facilities.includes(facility))
        throw new Error(`Missing facility ${facility}`);
  }

  spawnPositions(count: number): Vec2[] {
    const cells = new Rng(this.seed ^ 0xa5a5a5a5).shuffle(
      Array.from({ length: this.width * this.height }, (_, i) => i).filter(
        (i) => this.walkable(this.point(i)),
      ),
    );
    if (count > cells.length)
      throw new Error("Population exceeds walkable cells");
    return cells.slice(0, count).map((i) => this.point(i));
  }

  observe(
    tick: number,
    agent: AgentState,
    agents: AgentState[],
    artifacts: Artifact[],
    messages: Message[],
    publications: Publication[],
    radius: number,
    allowCulture: boolean,
    allowProgramAccess = allowCulture,
  ): LocalObservation {
    const cells: LocalObservation["cells"] = [];
    for (
      let y = Math.max(0, agent.position.y - radius);
      y <= Math.min(this.height - 1, agent.position.y + radius);
      y++
    )
      for (
        let x = Math.max(0, agent.position.x - radius);
        x <= Math.min(this.width - 1, agent.position.x + radius);
        x++
      ) {
        if (Math.hypot(x - agent.position.x, y - agent.position.y) > radius)
          continue;
        const p = { x, y },
          i = this.index(p);
        agent.observedCells.set(key(p), tick);
        cells.push({
          position: p,
          terrain: this.terrain[i]!,
          ...(this.resourceType[i]
            ? {
                resource: {
                  id: this.resourceType[i]!,
                  mass: this.resourceMass[i]!,
                },
              }
            : {}),
          ...(this.facilities[i] ? { facility: this.facilities[i]! } : {}),
          fields: Object.fromEntries(
            fields.map((f) => [f, this.fields[f][i]!]),
          ) as Record<FieldId, number>,
        });
      }
    const visibleArtifacts = artifacts
      .filter(
        (a) =>
          a.active &&
          Math.hypot(
            a.position.x - agent.position.x,
            a.position.y - agent.position.y,
          ) <= radius,
      )
      .map((a) => {
        const copy = structuredClone(a);
        if (!allowProgramAccess) {
          delete copy.programId;
          copy.programHistory = [];
          delete copy.spec;
        }
        return copy;
      });
    for (const artifact of visibleArtifacts)
      if (allowProgramAccess && artifact.programId)
        agent.observedPrograms.add(artifact.programId);
    const nearbyMessages = allowCulture
      ? messages.filter(
          (m) =>
            m.recipientId === agent.id ||
            (!m.recipientId &&
              Math.hypot(
                m.position.x - agent.position.x,
                m.position.y - agent.position.y,
              ) <= radius),
        )
      : [];
    return {
      tick,
      self: {
        id: agent.id,
        position: agent.position,
        inventory: { ...agent.inventory },
        batches: structuredClone(agent.batches),
        pendingBatches: structuredClone(agent.pendingBatches),
      },
      cells,
      agents: agents
        .filter(
          (a) =>
            a.id !== agent.id &&
            a.active &&
            Math.hypot(
              a.position.x - agent.position.x,
              a.position.y - agent.position.y,
            ) <= radius,
        )
        .map((a) => ({ id: a.id, position: a.position })),
      artifacts: visibleArtifacts,
      messages: structuredClone(nearbyMessages),
      publications: allowCulture
        ? structuredClone(publications.slice(-24))
        : [],
      affordances: [
        "MOVE",
        "INSPECT",
        "HARVEST",
        "DEPOSIT",
        "WITHDRAW",
        "FORMULATE",
        "PROCESS",
        "TEST",
        "CONSTRUCT",
        "INSTALL_PROGRAM",
        "REPAIR",
        "WAIT",
      ],
    };
  }

  advance(tick: number): void {
    const next: Record<FieldId, number[]> = Object.fromEntries(
      fields.map((f) => [f, [...this.fields[f]]]),
    ) as Record<FieldId, number[]>;
    for (const field of fields)
      for (let i = 0; i < this.width * this.height; i++) {
        const p = this.point(i),
          neighbors = [
            { x: p.x - 1, y: p.y },
            { x: p.x + 1, y: p.y },
            { x: p.x, y: p.y - 1 },
            { x: p.x, y: p.y + 1 },
          ].filter((q) => this.inside(q));
        const avg =
          neighbors.reduce(
            (sum, q) => sum + this.fields[field][this.index(q)]!,
            0,
          ) / neighbors.length;
        const decay = field === "contamination" ? 0.003 : 0.0005;
        next[field][i] = clip(
          (1 - decay) *
            (this.fields[field][i]! + 0.025 * (avg - this.fields[field][i]!)),
        );
      }
    const daylight =
      0.25 + 0.7 * (0.5 + 0.5 * Math.sin(((tick % 96) / 96) * Math.PI * 2));
    next.solar.fill(daylight);
    this.fields = next;
    for (let i = 0; i < this.resourceMass.length; i++)
      this.resourceMass[i] = Math.min(
        this.resourceCapacity[i]!,
        this.resourceMass[i]! +
          this.resourceRenewal[i]! *
            (this.resourceCapacity[i]! - this.resourceMass[i]!),
      );
  }

  disturb(
    seed: number,
    tick: number,
    intensity: number,
  ): { center: Vec2; kind: string } {
    const rng = new Rng(seed ^ Math.imul(tick + 1, 0x9e3779b1));
    const center = this.spawnPositions(
      this.width * this.height -
        this.terrain.filter((t) => t === "DEEP_WATER").length,
    )[rng.int(this.terrain.filter((t) => t !== "DEEP_WATER").length)]!;
    const kind = rng.pick([
      "drought",
      "contamination",
      "damage",
      "resource-variation",
    ]);
    const sigma = Math.max(1, 0.12 * Math.min(this.width, this.height));
    for (let i = 0; i < this.width * this.height; i++) {
      const p = this.point(i),
        h =
          intensity *
          Math.exp(
            -((p.x - center.x) ** 2 + (p.y - center.y) ** 2) / (2 * sigma ** 2),
          );
      if (kind === "drought")
        this.fields.water[i] = clip(this.fields.water[i]! - h);
      else if (kind === "contamination")
        this.fields.contamination[i] = clip(this.fields.contamination[i]! + h);
      else if (kind === "damage")
        this.fields.stability[i] = clip(this.fields.stability[i]! - h);
      else
        this.resourceMass[i] = Math.max(
          0,
          this.resourceMass[i]! * (1 - 0.5 * h),
        );
    }
    return { center, kind };
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      width: this.width,
      height: this.height,
      terrain: this.terrain,
      resourceType: this.resourceType,
      resourceMass: this.resourceMass,
      resourceCapacity: this.resourceCapacity,
      resourceRenewal: this.resourceRenewal,
      facilities: this.facilities,
      fields: this.fields,
      depots: this.depots,
    });
  }
  static fromSnapshot(seed: number, snapshot: WorldSnapshot): World {
    return new World(
      seed,
      snapshot.width,
      snapshot.height,
      structuredClone(snapshot),
    );
  }
}

function distanceSquared(a: Vec2, b: Vec2): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
