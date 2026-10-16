import { readFile } from 'node:fs/promises';
import { buildSource } from '../controlled-build/index.mjs';
import { BuildRejected } from '../controlled-build/policy.mjs';
try {
  const bytes = await readFile(process.argv[2]);
  if (bytes.length > 300000) throw new BuildRejected('Serialized input exceeds size limit', 'SOURCE_LIMIT');
  const manifest = await buildSource(JSON.parse(bytes.toString()));
  console.log(JSON.stringify({ status: 'BUILT', manifest }));
} catch (error) {
  const rejected = error instanceof BuildRejected && !['BUILD_TIMEOUT', 'BUILD_ERROR', 'BUILD_BUSY'].includes(error.code);
  console.log(JSON.stringify({ status: rejected ? 'REJECTED' : 'ERROR', code: error.code || 'INFRASTRUCTURE', message: error.message }));
  process.exitCode = rejected ? 1 : 2;
}
