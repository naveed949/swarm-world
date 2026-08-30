import { createServer } from "node:http";
import { z } from "zod";
import {
  createPiModelRequest,
  type RepositoryPlanRequestInput,
} from "./repository-pi-planner.js";
import type { RepositoryRunConfig } from "./run-config.js";

const requestSchema = z
  .object({
    agentId: z.string().regex(/^agent_[0-9]{6}$/),
    tick: z.number().int().nonnegative(),
    role: z.enum(["implementer", "collaborator"]),
    context: z.record(z.string(), z.unknown()),
  })
  .strict();

const provider = process.env.SWARM_WORLD_PI_PROVIDER;
const id = process.env.SWARM_WORLD_PI_MODEL;
const reasoning = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
  .parse(process.env.SWARM_WORLD_PI_REASONING ?? "medium");
if (!provider || !id) throw new Error("Pi sidecar model configuration is missing");

const requestPlan = createPiModelRequest({
  model: { provider, id, temperature: 0, reasoning },
} as RepositoryRunConfig);
const port = Number(process.env.SWARM_WORLD_PI_SIDECAR_PORT ?? "4317");

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ready"}');
    return;
  }
  if (request.method !== "POST" || request.url !== "/plan") {
    response.writeHead(404).end();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 2_000_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      try {
        const input = requestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        ) as RepositoryPlanRequestInput;
        const plan = await requestPlan(input);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(plan));
      } catch {
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":"planning failed"}');
      }
    })();
  });
});

server.listen(port, "0.0.0.0");
