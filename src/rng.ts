export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new Error("Cannot pick from empty array");
    return values[this.int(values.length)]!;
  }
  shuffle<T>(values: readonly T[]): T[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}
