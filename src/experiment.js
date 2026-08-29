import { World } from './world.js';
import { ScriptedAgentRuntime } from './runtime.js';
import { evaluateFrozen } from './evaluator.js';
export async function runCondition(config,runtime=new ScriptedAgentRuntime()){const world=new World(config);await world.run(runtime);const snapshot=world.snapshot();const evaluation=evaluateFrozen(snapshot);await runtime.close();return {config,snapshot,evaluation};}
export async function compareConditions({seed=1,agents=4,ticks=16}={}){const conditions=['full_culture','no_communication','stigmergy_only','independent'];const runs=[];for(const condition of conditions)runs.push(await runCondition({seed,agents,ticks,condition}));return {seed,agents,ticks,runs:runs.map(({config,evaluation})=>({condition:config.condition,evaluation}))};}
