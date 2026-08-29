import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Map)
    return canonicalJson(
      Object.fromEntries(
        [...value.entries()].sort(([a], [b]) =>
          String(a).localeCompare(String(b)),
        ),
      ),
    );
  if (value instanceof Set) return canonicalJson([...value].sort());
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}
export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}
