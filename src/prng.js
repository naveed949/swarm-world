export function prng(seed) { let state = (seed >>> 0) || 1; return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; }; }
