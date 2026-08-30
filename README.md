# SwarmWorld

An independent, reproducible implementation of **“SwarmWorld: Stigmergic technological evolution in societies of language-model agents”** (Pal, Wang, and Buehler, 2026).

This is a simulation engine, not a group-chat demo. Initially homogeneous agents receive local observations, propose bounded plans, and leave all consequences to a deterministic, materially constrained world. They can discover materials, construct persistent artifacts, install bounded executable controllers, inherit grounded programs, and coordinate through both explicit culture and physical stigmergy. Frozen portfolios are evaluated after every agent has been removed.

## What is implemented

- Fixed-seed 2D worlds with typed terrain, eight source-accounted resources, six processing facilities, continuous fields, renewal, diffusion, decay, day cycles, and seeded disturbances.
- Validated, data-only scenario packages with path containment, complete stable resource/facility/field slots, normalized geometry, nearest-walkable facility placement, and content hashes. Scenario documents cannot execute code or alter the engine.
- Nested, population-independent initial positions and staggered macroturn phases.
- Local semantic observations, sparse empirical maps, 64-record private memory, research-state updates, and bounded action queues with at most one attempted action per agent per tick.
- Strict proposal/consequence separation. Agent text cannot alter physics, inventory, measurements, service, provenance, or evaluation.
- Grounded harvesting, conserved shared-depot deposit/withdrawal, typed recipes processed in declared order at each physical workstation, private pending microbatches, deterministic tests, construction, repair, dismantling, and closed artifact fluxes.
- A 16-register, 64-instruction maximum artifact VM. It has sensors, arithmetic, comparisons, and capability-scoped actuators, but no loops, jumps, imports, allocation, strings-as-code, network, files, shell, or dynamic execution.
- Content-addressed programs, exact parent/child lineage, empirical access rules, changed-instruction requirements for forks, and permanent installation history.
- Full-culture, no-communication, no-explicit-culture, and independent-search treatment contracts. Disabled mechanisms are removed from execution, not hidden only in the prompt.
- Local messaging, addressed delivery on the recipient’s next scheduled decision, publication with owned evidence, teaching, physical trade, and task claims.
- Immutable JSONL event traces, config and trace hashes, frozen checkpoints, paired unseen disturbance schedules, agent-free evaluation, balanced portfolio resilience, discovery-frontier AUC, and endpoint-wise best-of-N isolated envelopes.
- Pi SDK integration through `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, using a provider-constrained `submit_plan` tool plus a second local Zod validation boundary. A deterministic heuristic cognition mode supports tests and no-cost smoke runs.

The published paper reports a specific engine revision, prompt, and experimental dataset that were not publicly obtainable when this repository was created. This implementation preserves the disclosed scientific architecture and invariants; it does **not** claim bit-for-bit identity with the authors’ unreleased source or reproduction of their reported numerical results.

## Quick start

```bash
npm install
npm run verify
npm run demo
```

The demo uses deterministic heuristic cognition and writes a hashed run under `runs/`.

Run LLM agents through Pi:

```bash
pi auth check --provider openai-codex
npm run build
node dist/cli.js run --config examples/minimal-pi.yaml
```

Pi cognition uses the canonical `ModelRuntime`, which loads stored credentials
from `~/.pi/agent/auth.json`. Run `pi` and use `/login` with the
`openai-codex` provider first if the authentication check fails. An
`OPENAI_API_KEY` is only needed when a configuration explicitly selects the
separate `openai` API provider.

Run the mechanism-resolved population study matrix:

```bash
node dist/cli.js matrix \
  --config examples/paper-800.yaml \
  --conditions full,no-communication,no-explicit-culture,independent \
  --populations 50,100,200 \
  --seeds 3201,3202,3203,3204
```

This schedule is expensive: the paper’s completed 800-tick matrix used roughly 89,617 provider calls. Start with `examples/minimal.yaml` and Pi cognition before launching the full matrix.

Verify an immutable shared-world trace:

```bash
node dist/cli.js verify runs/<run-id>/trace.jsonl
```

## Runtime sequence

For every tick:

1. Agents whose fixed macroturn phase is due receive a local observation and bounded private/permitted shared context.
2. Pi returns one research-state update and at most `planLimit` atomic actions.
3. Local schema validation commits the bounded queue; invalid output becomes a recorded failed decision.
4. Every active agent attempts at most one queued action in stable ID order.
5. The simulator checks location, possession, evidence, capacity, treatment, material, and program permissions.
6. Environmental fields, resources, and disturbances advance.
7. Every installed artifact controller executes once, including between agent decisions.
8. Authoritative events enter private memory and the immutable trace.
9. At a configured checkpoint, an exact frozen copy is evaluated with no agents and no model calls.

## Experimental conditions

| Condition           |         Shared world | Messages/publication/teaching/trade | Cross-agent program access | Program forks | Physical stigmergy |
| ------------------- | -------------------: | ----------------------------------: | -------------------------: | ------------: | -----------------: |
| Full culture        |                  Yes |                                 Yes |                        Yes |           Yes |                Yes |
| No communication    |                  Yes |                                  No |        Physically observed |           Yes |                Yes |
| No explicit culture |                  Yes |                                  No |                         No |            No |                Yes |
| Independent search  | One world per member |                                  No |                         No |            No |  No across members |

Independent search is summarized as an **endpoint-wise envelope**. The winning isolated member may differ by checkpoint, service, discovery AUC, final performance, or held-out resilience.

## Artifact VM

Programs are canonical instruction arrays. SHA-256 of instruction content—not an agent-supplied name or ancestry claim—is the program identity. Registers are clipped to `[-4, 4]`; extensive actuator requests are capped at `0.05` normalized units per tick and then reduced again by source availability and artifact capacity.

Sensors cover local fields, artifact state, storage/reserve/opening, and measured material properties. Actuators request water collection, growth, healing, opening changes, contamination removal, and signal emission. The physics layer decides the realized amount.

## Reproducibility boundary

Every shared run writes:

- `summary.json`: configuration hash, trace hash, discovery metrics, artifact/program counts, and held-out results.
- `trace.jsonl`: resolved configuration and manifest followed by immutable authoritative events.

Tests cover fixed-seed generation, nested spawns, deterministic simulation, treatment enforcement, VM limits, content identity, flux conservation, and agent-free evaluation. CI runs type checking, linting, tests with coverage, and a production build.

## Architecture

```text
src/
  cognition.ts   Pi and deterministic cognition adapters
  config.ts      validated experiment configuration and treatment contracts
  world.ts       authoritative lattice, resources, fields, generation, disturbances
  materials.ts   grounded recipes, fabrication, tests, numerical properties
  vm.ts          bounded persistent artifact controller runtime
  engine.ts      macroturn scheduling, action queues, validation, provenance
  evaluation.ts  frozen agent-free stress evaluation
  experiment.ts  shared studies and endpoint-wise isolated envelopes
  metrics.ts     discovery and portfolio endpoints
  scenario.ts    contained, validated, content-hashed world packages
  trace.ts       canonical immutable event traces
```

## Design rules

1. Agents may author proposals, interpretations, names, architectures, and controllers; only the simulator authors consequences.
2. Information cannot fabricate matter, measurements, permissions, contribution, or causal ancestry.
3. Renderers and analysis never mutate authoritative state.
4. Ablations change the model-facing schema **and** the simulator contract.
5. Agents, ticks, artifacts, schedules, and network edges are nested observations; independently generated world seeds are the unit of inference.

## License

MIT. The paper and any eventual authors’ implementation retain their respective copyrights and licenses.
