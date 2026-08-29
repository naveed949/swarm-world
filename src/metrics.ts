import type { Artifact, EventRecord, ServiceId } from "./types.js";
import { materialUtility } from "./materials.js";

const serviceIds: ServiceId[] = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
];

export function artifactPerformance(artifact: Artifact): number {
  return (
    serviceIds.reduce((sum, id) => sum + artifact.lastServices[id], 0) /
    serviceIds.length
  );
}

export function portfolioCoverage(
  artifacts: Artifact[],
): Record<ServiceId, number> {
  return Object.fromEntries(
    serviceIds.map((service) => [
      service,
      Math.max(
        0,
        ...artifacts
          .filter((a) => a.active)
          .map((a) => a.lastServices[service]),
      ),
    ]),
  ) as Record<ServiceId, number>;
}

export function balancedCoverage(coverage: Record<ServiceId, number>): number {
  const values = serviceIds.map((s) => coverage[s]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  return mean * (0.5 + (0.5 * Math.min(...values)) / mean);
}

export function discoveryFrontierAuc(
  events: EventRecord[],
  horizon: number,
): number {
  const points: Array<[number, number]> = [[0, 0]];
  let frontier = 0;
  for (const event of events)
    if (event.type === "artifact_program_executed" && event.success) {
      const values = Object.values(
        (event.data.services ?? {}) as Record<string, number>,
      );
      const score = values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
      if (score > frontier) {
        frontier = score;
        points.push([event.tick, frontier]);
      }
    }
  points.push([horizon, frontier]);
  let area = 0;
  for (let i = 1; i < points.length; i++)
    area +=
      ((points[i]![0] - points[i - 1]![0]) *
        (points[i - 1]![1] + points[i]![1])) /
      2;
  return area / Math.max(1, horizon);
}

export function isValidatedInvention(artifact: Artifact): boolean {
  return Boolean(
    artifact.spec?.name &&
    artifact.spec.claimedFunction &&
    artifact.spec.architecture &&
    artifact.spec.bioInspiration.length &&
    artifact.programId &&
    materialUtility(artifact.properties) >= 0.4 &&
    artifact.peakPerformance >= 0.2,
  );
}
