# SwarmWorld

SwarmWorld is a deterministic, software-native research environment for testing whether persistent, verifiable shared work improves long-horizon agent outcomes over isolated search.

It is deliberately not an agent orchestrator. The kernel owns state, action legality, artifacts, lineage, trace persistence, and evaluation. An agent runtime only proposes structured actions.

## MVP

- Seeded task world with partial local observations and fixed turns.
- Transactional action resolver and append-only, hash-chained trace.
- Persistent artifacts with evidence and parent lineage.
- Four ablations: `full_culture`, `no_communication`, `stigmergy_only`, `independent`.
- Freeze-and-remove-agent held-out evaluation with deterministic disturbances.
- Replaceable `AgentRuntime`, deterministic scripted runtime, and optional Pi adapter.
- Reproducible experiment CLI and integration tests.

## Run

```sh
npm test
npm run experiment -- --seed 42 --agents 4 --ticks 16
```

The CLI emits a JSON comparison in `out/`. It does not need model credentials; the scripted runtime supplies deterministic baseline behavior. To connect Pi, instantiate `PiAgentRuntime` with a session factory in application code. Pi is intentionally an optional peer dependency so the scientific kernel remains provider-independent.

## Core contract

`AgentRuntime.decide(input)` returns only a schema-shaped plan. It has no authority to mutate state. The world validates and resolves every action, and the evaluator runs after all agents are removed.

## Status

MVP implemented. Next research step: add a real task/repository scenario package and compare Pi-driven cohorts with the scripted baseline under equal call and token budgets.
