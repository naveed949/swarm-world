import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "./hash.js";
import type { EventRecord, ExperimentConfig, RunSummary } from "./types.js";

export class Trace {
  readonly events: EventRecord[] = [];
  private previousDigest = "genesis";
  constructor(
    readonly config: ExperimentConfig,
    readonly manifest: Record<string, unknown>,
  ) {}
  append(event: Omit<EventRecord, "previousDigest" | "digest">): EventRecord {
    const base = {
      ...structuredClone(event),
      previousDigest: this.previousDigest,
    };
    const chained: EventRecord = { ...base, digest: sha256(base) };
    this.previousDigest = chained.digest;
    this.events.push(chained);
    return chained;
  }
  hash(): string {
    return sha256({
      config: this.config,
      manifest: this.manifest,
      events: this.events,
    });
  }
  async write(path: string, summary: RunSummary): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const header = canonicalJson({
      type: "manifest",
      config: this.config,
      manifest: this.manifest,
      summary,
    });
    const lines = [
      header,
      ...this.events.map((event) =>
        canonicalJson({ recordType: "event", event }),
      ),
    ];
    await writeFile(path, `${lines.join("\n")}\n`);
  }
}
