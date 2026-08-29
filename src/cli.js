import { mkdir, writeFile } from 'node:fs/promises';
import { compareConditions } from './experiment.js';
const args=Object.fromEntries(process.argv.slice(2).filter((v)=>v.startsWith('--')).map((v)=>v.slice(2).split('='))); const value=(key,fallback)=>Number(args[key]??fallback); const result=await compareConditions({seed:value('seed',42),agents:value('agents',4),ticks:value('ticks',16)}); await mkdir('out',{recursive:true}); const file=`out/experiment-${result.seed}.json`;await writeFile(file,JSON.stringify(result,null,2));console.log(JSON.stringify({file,...result},null,2));
