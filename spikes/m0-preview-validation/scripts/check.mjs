import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPreview } from '../runtime/server.mjs';
import { validate, scenarios } from '../runtime/validator.mjs';

const single = process.argv.includes('--single');
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex === -1 ? 'normal' : process.argv[scenarioIndex + 1];
if (!scenarios.includes(scenario)) throw new Error('Scenario must be normal or fault');
const preview = await createPreview({ port: 0, host: '127.0.0.1', token: undefined });
const reports = [];
try {
  for (const item of single ? [scenario] : scenarios) {
    const report = await validate({ ...preview, scenario: item });
    reports.push(report);
    console.log(JSON.stringify({ scenario: item, status: report.status, runId: report.runId, evidenceDirectory: report.evidenceDirectory }));
  }
  if (single) process.exitCode = reports[0].status === 'PASS' ? 0 : reports[0].status === 'FAIL' ? 1 : 2;
  else {
    const accepted = reports[0].status === 'PASS' && reports[1].status === 'FAIL' &&
      reports[1].actualResult.interactionCompleted && reports[1].actualResult.taskCountAfter === 0;
    const suiteId = `suite-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const summary = {
      suiteId, finishedAt: new Date().toISOString(), status: accepted ? 'PASS' : 'ERROR',
      meaning: 'Harness acceptance: normal must PASS and injected fault must produce genuine FAIL.',
      runs: reports.map(({ runId, scenario, status, evidenceDirectory }) => ({ runId, scenario, status, evidenceDirectory })),
    };
    const file = resolve(preview.evidenceRoot, `${suiteId}.json`);
    await writeFile(file, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ harnessAcceptance: summary.status, summary: file }));
    process.exitCode = accepted ? 0 : 2;
  }
} finally { await preview.close(); }
