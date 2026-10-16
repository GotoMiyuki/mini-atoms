import {writeFile,access,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');await mkdir(resolve(root,'.local'),{recursive:true});
try{await access(resolve(root,'.env.local'));console.log('Existing .env.local preserved');}
catch{await writeFile(resolve(root,'.env.local'),`M1_ACCESS_TOKEN=${randomBytes(32).toString('hex')}\nM1_PORT=8120\nM1_DAILY_JOBS=20\nLLM_BASE_URL=\nLLM_MODEL=\nLLM_API_KEY=\n`,{flag:'wx',mode:0o600});console.log('Created ignored .env.local. Configure LLM credentials locally; never paste them into chat.');}
