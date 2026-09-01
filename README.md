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
- A shared `Environment` lifecycle (`observe`, `resolve`, `advance`, `freeze`, and `evaluate`) with BioFoundry and local TypeScript/Node repository adapters.
- Repository-native typed graphs, bounded graph observations, evidence-owned inspection and search, read-only dry runs, isolated Git worktrees, preconditioned structured edits, fixed configured checks, content-addressed artifacts, deterministic integration queues, immutable action traces, and clean agent-free evaluation.
- Goal-directed repository societies with evidence-backed problem discovery, admitted task decomposition, agent-authored temporary roles, leased differentiated commitments, competing candidate worktrees, mandatory independent verification, deterministic evidence-first selection, periodic checkpoints, and bounded success/stall termination.

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

## Repository environments

Repository runs are constructed through `RepositoryEnvironment.create`. They are bound to a canonical local Git root and exact base commit. Read-only mode is the default; writable mode must be explicit and requires a clean base checkout outside configured exclusions.

Facilities are operator configuration, not agent-selected commands. Each facility uses an absolute executable, fixed arguments, a timeout, bounded output, an explicit environment, and a mandatory/optional verification classification. Repository agents receive only the action vocabulary exposed by the adapter; arbitrary shell execution, dependency installation, network access, base-checkout mutation, pushes, merges, deployments, and tracker changes are not available.

### Containerized Sandcastle survey

The retained example surveys the real `naveed949/sandcastle` repository at pinned commit `b03b295836bdc7ce67846814f02a80705c162122`. It is a read-only two-agent run: agents claim, inspect, and search repository nodes, then a fixed Node facility checks the package and isolation sources. No patch is eligible by design.

```bash
npm run example:sandcastle:prepare
npm run example:sandcastle
```

The first command downloads the pinned source to the ignored `.examples/` directory. The second builds the runner image, mounts that checkout read-only, copies it to ephemeral container storage, disables runtime networking, drops Linux capabilities, enables `no-new-privileges`, makes the container root filesystem read-only, and applies CPU, memory, and process limits. Only `runs/sandcastle-container/` is retained on the host.

To survey another already-local repository, use a config with an exact commit and run:

```bash
sh scripts/run-repository-container.sh \
  /absolute/path/to/repository \
  /absolute/path/to/repository-config.yaml \
  runs/repository-container
```

Do not mount credentials or the Docker socket into this runner. Docker narrows the blast radius but does not make untrusted code risk-free; use a disposable Docker context or VM for stronger host isolation.

After reviewing the survey output, run the bounded writable demonstration:

```bash
npm run example:sandcastle:write
```

This uses a scripted, operator-owned change specification to add the explicit issue repository to Sandcastle's example environment. The host checkout remains read-only. The container may change only `.sandcastle/.env.example` in its ephemeral clone, must pass the fixed `env-contract` facility, and retains `artifact.patch` plus `artifact.mbox` for review. It does not push to Sandcastle.

The public repository lifecycle is:

1. Create an agent and observe its stable, bounded graph neighborhood.
2. Inspect or search visible paths to acquire owned evidence.
3. In writable mode, formulate an evidence-backed change recipe with declared targets and checks.
4. Apply structured edits against expected content hashes in an isolated worktree.
5. Run configured facilities; later edits invalidate their evidence.
6. Construct a content-addressed commit artifact after all mandatory checks pass.
7. Queue integration, advance the environment, and freeze the resulting exact candidate commit.
8. Evaluate the frozen commit in a clean, agent-free checkout.

### Emergent repository societies

Repository configurations may include an immutable `goal` contract containing
measurable success, action/write/attempt/verification/model budgets, checkpoint
frequency, sustained-success requirements, a no-progress limit, and a maximum
population of five agents. Non-isolated societies require three to five agents.
Every proposed problem and task is bound to the operator's goal; task admission
cannot widen the operator-owned paths, facilities, or budget. When a goal is
present, agents are not assigned permanent implementer or collaborator identities.
They can instead:

1. Publish an evidence-owned problem and have another agent confirm or
   challenge it.
2. Propose an admitted task or decompose an existing task without widening its
   path authority.
3. Claim a leased commitment with an agent-authored role and differentiated
   approach. Duplicate active approaches are rejected; abandoned commitments
   expire.
4. Formulate and implement competing recipes in the existing isolated Git
   worktrees.
5. Submit immutable candidate commits and request verification.
6. Verify another agent's artifact from a clean checkout. Authors cannot verify
   their own artifacts. In the isolated `independent-search` treatment, an
   agent-free environment verifier runs the same mandatory facilities so the
   one-member world is not forced to self-approve.
7. Recommend eligible candidates and request controlled integration only after
   the whole submitted portfolio has independent results for every mandatory
   visible facility.
8. Let the environment select one winner by mandatory evidence,
   recommendations, task coverage, changed-line cost, and stable artifact ID.

Role labels never grant authority. All permissions continue to derive from the
environment, treatment, path policy, evidence ownership, commitment state, and
authorship separation. Hidden facilities remain unavailable during discovery
and run only in agent-free checkpoint/final evaluation. Disabled treatment
actions are removed from each model request's action schema. Problems, tasks,
commitments, attempts, verifications, and selections are recorded in an
append-only society ledger. Frozen checkpoints contain the immutable task,
proposal, path, attempt, and governance state needed for later evaluation, while
operator-authored mandatory facilities remain the sole scoring gates.

`maxAttempts` counts implementation attempts begun at formulation, rather than
task claims or team membership. `maxModelCalls` counts only model-backed planner
invocations and is enforced before scheduling a call. Isolated
`independent-search` members partition one shared experiment budget, so increasing
the population does not multiply actions, writes, attempts, verifications, or
model calls.

Without a `goal`, repository configurations retain the original single-task
legacy lifecycle for compatibility with retained examples.

Compare the same pinned repository, goal, facilities, population and budget
across the four coordination models:

```bash
node dist/cli.js repository-matrix \
  --config examples/repository/sandcastle-issue-26-pi.yaml \
  --models emergent-society,fixed-workflow,central-supervisor,independent-search
```

Each model produces its own retained run and the command returns a compact
comparison of completion, hard gates, correctness, regression safety, issue
coverage, maintainability, robustness, trace identity, and stopping reason.

`EnvironmentSimulator` supplies stable scheduling, bounded action queues, macroturn phases, and hash-chained consequence records without depending on either environment's domain model.

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
  environment.ts shared authoritative lifecycle contract
  environment-simulator.ts domain-neutral bounded scheduler
  biofoundry-environment.ts BioFoundry lifecycle adapter
  repository-environment.ts repository graph, evidence, patches, checks, artifacts, integration, evaluation
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
