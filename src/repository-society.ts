import type {
  RepositoryArtifact,
  RepositorySocietyRecord,
} from "./repository-types.js";

export interface RankedRepositoryCandidate {
  artifact: RepositoryArtifact;
  passedFacilities: number;
  recommendations: number;
  taskCoverage: number;
  changedLines: number;
}

export function rankRepositoryCandidates(
  candidates: RepositoryArtifact[],
  passedFacilities: (artifactId: string) => number,
  recommendations: (artifactId: string) => number,
): RankedRepositoryCandidate[] {
  return candidates
    .map((artifact) => ({
      artifact,
      passedFacilities: passedFacilities(artifact.id),
      recommendations: recommendations(artifact.id),
      taskCoverage: artifact.taskIds.length,
      changedLines: artifact.changedLines ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        b.passedFacilities - a.passedFacilities ||
        b.recommendations - a.recommendations ||
        b.taskCoverage - a.taskCoverage ||
        a.changedLines - b.changedLines ||
        a.artifact.id.localeCompare(b.artifact.id),
    );
}

/** Append-only, typed history for repository-society governance decisions. */
export class RepositorySocietyLedger {
  private readonly records: RepositorySocietyRecord[] = [];

  append(
    tick: number,
    entityType: RepositorySocietyRecord["entityType"],
    entityId: string,
    eventType: string,
    snapshot: unknown,
  ): void {
    this.records.push({
      sequence: this.records.length,
      tick,
      entityType,
      entityId,
      eventType,
      snapshot: structuredClone(snapshot),
    });
  }

  snapshot(): RepositorySocietyRecord[] {
    return structuredClone(this.records);
  }
}
