import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { sha256 } from "./hash.js";
import type { ScenarioPackage } from "./types.js";

const shape = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("circle"),
      center: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
      radius: z.number().positive().max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ellipse"),
      center: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
      radius: z.tuple([
        z.number().positive().max(1),
        z.number().positive().max(1),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rectangle"),
      bounds: z.tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ]),
    })
    .strict(),
]);
const resource = z.enum([
  "CELLULOSE",
  "CHITIN",
  "MINERAL",
  "FUNGAL",
  "CATALYST",
  "KELP",
  "SHELL",
  "LIGNIN",
]);
const facility = z.enum([
  "WASH",
  "DRY",
  "CROSSLINK",
  "FERMENT",
  "ALIGN",
  "MINERALIZE",
]);
const field = z.enum([
  "temperature",
  "water",
  "stability",
  "contamination",
  "solar",
  "nutrients",
]);
const manifestSchema = z
  .object({
    format_version: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    documents: z
      .object({
        geometry: z.string(),
        resources: z.string(),
        facilities: z.string(),
        fields: z.string(),
      })
      .strict(),
  })
  .strict();
const geometrySchema = z
  .object({
    base_terrain: z.string().min(1),
    features: z
      .array(z.object({ terrain: z.string().min(1), shape }).strict())
      .default([]),
  })
  .strict();
const resourcesSchema = z
  .object({
    deposits: z.array(
      z
        .object({
          resource,
          shape,
          capacity: z.number().positive(),
          capacity_variation: z.number().min(0).max(1).default(0.15),
          initial_fill: z
            .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
            .default([0.55, 0.9]),
          renewal: z.number().min(0).max(1).default(0.002),
        })
        .strict(),
    ),
  })
  .strict();
const facilitiesSchema = z
  .object({
    placements: z.array(
      z
        .object({
          facility,
          position: z.tuple([
            z.number().min(0).max(1),
            z.number().min(0).max(1),
          ]),
        })
        .strict(),
    ),
  })
  .strict();
const fieldsSchema = z
  .object({ initial: z.record(field, z.number().min(0).max(1)) })
  .strict();

function contained(root: string, relative: string): string {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error(`Scenario document escapes package: ${relative}`);
  return path;
}

export async function loadScenarioPackage(
  manifestPath: string,
): Promise<ScenarioPackage> {
  const absolute = resolve(manifestPath),
    root = dirname(absolute);
  const manifestText = await readFile(absolute, "utf8");
  const manifest = manifestSchema.parse(YAML.parse(manifestText));
  const read = async <T>(
    name: keyof typeof manifest.documents,
    schema: z.ZodType<T>,
  ): Promise<{ text: string; value: T }> => {
    const text = await readFile(
      contained(root, manifest.documents[name]),
      "utf8",
    );
    return { text, value: schema.parse(YAML.parse(text)) };
  };
  const [geometry, resources, facilities, fields] = await Promise.all([
    read("geometry", geometrySchema),
    read("resources", resourcesSchema),
    read("facilities", facilitiesSchema),
    read("fields", fieldsSchema),
  ]);
  const resourceIds = new Set(resources.value.deposits.map((d) => d.resource));
  const facilityIds = new Set(
    facilities.value.placements.map((p) => p.facility),
  );
  for (const id of resource.options)
    if (!resourceIds.has(id))
      throw new Error(`Scenario missing resource slot ${id}`);
  for (const id of facility.options)
    if (!facilityIds.has(id))
      throw new Error(`Scenario missing facility slot ${id}`);
  for (const id of field.options)
    if (fields.value.initial[id] === undefined)
      throw new Error(`Scenario missing compatibility field ${id}`);
  return {
    formatVersion: 1,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    sourceHash: sha256([
      manifestText,
      geometry.text,
      resources.text,
      facilities.text,
      fields.text,
    ]),
    baseTerrain: geometry.value.base_terrain,
    features: geometry.value.features,
    deposits: resources.value.deposits.map((d) => ({
      resource: d.resource,
      shape: d.shape,
      capacity: d.capacity,
      capacityVariation: d.capacity_variation,
      initialFill: d.initial_fill,
      renewal: d.renewal,
    })),
    facilityPlacements: facilities.value.placements,
    fieldInitial: fields.value.initial,
  };
}
