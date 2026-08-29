import { sha256 } from "./hash.js";
import type {
  AgentState,
  FacilityId,
  MaterialBatch,
  MaterialProperties,
  PendingBatch,
  Recipe,
  ResourceId,
} from "./types.js";

const vectors: Record<ResourceId, MaterialProperties> = {
  CELLULOSE: {
    stiffness: 0.65,
    toughness: 0.45,
    permeability: 0.35,
    adhesion: 0.35,
    healing: 0.15,
    responsiveness: 0.2,
    degradation: 0.5,
  },
  CHITIN: {
    stiffness: 0.6,
    toughness: 0.72,
    permeability: 0.25,
    adhesion: 0.45,
    healing: 0.25,
    responsiveness: 0.2,
    degradation: 0.25,
  },
  MINERAL: {
    stiffness: 0.92,
    toughness: 0.42,
    permeability: 0.08,
    adhesion: 0.2,
    healing: 0.02,
    responsiveness: 0.05,
    degradation: 0.05,
  },
  FUNGAL: {
    stiffness: 0.25,
    toughness: 0.5,
    permeability: 0.62,
    adhesion: 0.7,
    healing: 0.86,
    responsiveness: 0.75,
    degradation: 0.7,
  },
  CATALYST: {
    stiffness: 0.12,
    toughness: 0.18,
    permeability: 0.7,
    adhesion: 0.5,
    healing: 0.6,
    responsiveness: 0.95,
    degradation: 0.65,
  },
  KELP: {
    stiffness: 0.18,
    toughness: 0.68,
    permeability: 0.72,
    adhesion: 0.62,
    healing: 0.45,
    responsiveness: 0.7,
    degradation: 0.72,
  },
  SHELL: {
    stiffness: 0.82,
    toughness: 0.58,
    permeability: 0.12,
    adhesion: 0.3,
    healing: 0.08,
    responsiveness: 0.1,
    degradation: 0.08,
  },
  LIGNIN: {
    stiffness: 0.78,
    toughness: 0.62,
    permeability: 0.18,
    adhesion: 0.4,
    healing: 0.12,
    responsiveness: 0.15,
    degradation: 0.18,
  },
};

const effects: Record<FacilityId, Partial<MaterialProperties>> = {
  WASH: { degradation: -0.08, adhesion: 0.05 },
  DRY: { stiffness: 0.12, toughness: -0.04 },
  CROSSLINK: { stiffness: 0.1, toughness: 0.16, degradation: -0.1 },
  FERMENT: { healing: 0.18, responsiveness: 0.12, degradation: 0.08 },
  ALIGN: { stiffness: 0.14, toughness: 0.08, permeability: -0.06 },
  MINERALIZE: { stiffness: 0.2, permeability: -0.1, degradation: -0.14 },
};

const clip = (x: number) => Math.max(0, Math.min(1, x));

export function validateRecipe(recipe: Recipe): void {
  const mass = Object.values(recipe.inputs).reduce((a, b) => a + (b ?? 0), 0);
  if (mass <= 0 || mass > 2) throw new Error("Recipe mass must be in (0, 2]");
  if (recipe.operations.length < 1 || recipe.operations.length > 8)
    throw new Error("Recipe requires 1-8 operations");
  for (const value of [
    recipe.hydration,
    recipe.porosity,
    recipe.alignment,
    recipe.crosslinking,
  ])
    if (value < 0 || value > 1)
      throw new Error("Recipe controls must be normalized");
}

export function beginProcessing(
  agent: AgentState,
  recipe: Recipe,
  evidenceIds: string[],
): PendingBatch {
  validateRecipe(recipe);
  for (const [resource, amount] of Object.entries(recipe.inputs) as Array<
    [ResourceId, number]
  >) {
    if ((agent.inventory[resource] ?? 0) < amount)
      throw new Error(`Insufficient ${resource}`);
  }
  for (const [resource, amount] of Object.entries(recipe.inputs) as Array<
    [ResourceId, number]
  >)
    agent.inventory[resource] = (agent.inventory[resource] ?? 0) - amount;
  const id = `pending_${sha256({ owner: agent.id, recipe, index: agent.pendingBatches.length + agent.batches.length }).slice(0, 16)}`;
  return {
    id,
    ownerId: agent.id,
    recipe: structuredClone(recipe),
    nextOperationIndex: 1,
    contributors: [agent.id],
    evidenceIds,
  };
}

export function finishProcessing(
  agent: AgentState,
  pending: PendingBatch,
): MaterialBatch {
  const { recipe } = pending;
  const total = Object.values(recipe.inputs).reduce((a, b) => a + (b ?? 0), 0);
  const properties = Object.fromEntries(
    Object.keys(vectors.CELLULOSE).map((key) => {
      const property = key as keyof MaterialProperties;
      let value = 0;
      for (const [resource, amount] of Object.entries(recipe.inputs) as Array<
        [ResourceId, number]
      >)
        value += (vectors[resource][property] * amount) / total;
      for (const operation of recipe.operations)
        value += effects[operation][property] ?? 0;
      return [property, clip(value)];
    }),
  ) as unknown as MaterialProperties;
  properties.permeability = clip(
    properties.permeability * (0.6 + 0.8 * recipe.porosity),
  );
  properties.stiffness = clip(
    properties.stiffness * (0.75 + 0.5 * recipe.alignment),
  );
  properties.toughness = clip(
    properties.toughness * (0.75 + 0.5 * recipe.crosslinking),
  );
  properties.healing = clip(
    properties.healing * (0.6 + 0.8 * recipe.hydration),
  );
  const quality = clip(
    0.35 + 0.08 * new Set(recipe.operations).size + 0.2 * Math.min(total, 1),
  );
  const id = `batch_${sha256({ pendingId: pending.id, recipe }).slice(0, 16)}`;
  return {
    id,
    ownerId: agent.id,
    recipe,
    properties,
    quality,
    tested: false,
    contributors: [...pending.contributors],
    evidenceIds: [...pending.evidenceIds],
  };
}

export function materialUtility(p: MaterialProperties): number {
  return clip(
    (p.stiffness +
      p.toughness +
      p.adhesion +
      p.healing +
      p.responsiveness +
      (1 - p.degradation)) /
      6,
  );
}
