import { digest } from './hash.js';
import { prng } from './prng.js';
export function evaluateFrozen(snapshot, disturbanceSeeds = [101, 102, 103]) {
 const verified = snapshot.artifacts.filter((a) => a.status === 'verified');
 const scores = disturbanceSeeds.map((seed) => { const random = prng(seed); return verified.reduce((score, artifact) => score + 1 + (artifact.parentId ? .5 : 0) - (random() > .8 ? .25 : 0), 0); });
 const result={traceDigest:snapshot.traceDigest,agentsRemoved:true,disturbances:disturbanceSeeds,verifiedArtifacts:verified.length,lineageDepth:Math.max(0,...verified.map((a)=>a.parentId?2:1)),resilience:scores.reduce((a,b)=>a+b,0)/scores.length}; return {...result,digest:digest(result)};
}
