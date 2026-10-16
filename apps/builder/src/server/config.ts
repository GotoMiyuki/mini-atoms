import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {configuredOrigin} from './deployment-origin.ts';
export const appRoot=resolve(import.meta.dirname,'../..');
if(existsSync(resolve(appRoot,'.env.local')))process.loadEnvFile(resolve(appRoot,'.env.local'));
export function configuration(){
  const port=Number(process.env.M1_PORT||8120),maxDaily=Number(process.env.M1_DAILY_JOBS||20);
  if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(maxDaily)||maxDaily<1||maxDaily>100)throw new Error('Invalid M1 limits');
  const token=process.env.M1_ACCESS_TOKEN||'';
  if(token.length<32)throw new Error('M1_ACCESS_TOKEN must contain at least 32 characters; run npm run setup');
  return {port,origin:configuredOrigin(process.env.M1_PUBLIC_ORIGIN,port),token,maxDaily,dataRoot:resolve(process.env.M1_DATA_ROOT||resolve(appRoot,'.local/data')),provider:{baseUrl:process.env.LLM_BASE_URL||'',model:process.env.LLM_MODEL||'',apiKey:process.env.LLM_API_KEY||'',timeoutMs:60000}};
}
