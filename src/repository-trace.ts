import { sha256 } from "./hash.js";
import type { RepositoryTraceEvent } from "./repository-types.js";

/** Append-only hash chain for authoritative repository consequences. */
export class RepositoryTrace {
  private readonly events: RepositoryTraceEvent[] = [];

  get length(): number {
    return this.events.length;
  }

  append(
    type: string,
    accepted: boolean,
    actorId: string | undefined,
    targetId: string | undefined,
    data: Record<string, unknown>,
  ): RepositoryTraceEvent {
    const previousDigest = this.hash();
    const base = {
      sequence: this.events.length,
      type,
      accepted,
      ...(actorId ? { actorId } : {}),
      ...(targetId ? { targetId } : {}),
      data,
      previousDigest,
    };
    const event = { ...base, digest: sha256(base) };
    this.events.push(event);
    return event;
  }

  appendFacilityCompleted(
    actorId: string,
    evidenceId: string,
    data: {
      facilityId: string;
      success: boolean;
      exitCode: number;
      outputDigest: string;
      output: string;
    },
  ): RepositoryTraceEvent {
    return this.append(
      "facility_completed",
      data.success,
      actorId,
      evidenceId,
      data,
    );
  }

  hash(): string {
    return this.events.at(-1)?.digest ?? "genesis";
  }

  snapshot(): RepositoryTraceEvent[] {
    return structuredClone(this.events);
  }
}
