export const unique = '${RUN_UNIQUE}';
const todoSteps = [
  { action: 'assertCount', target: 'task-item', expected: 0 },
  { action: 'fill', target: 'task-input', value: unique },
  { action: 'click', target: 'add-button' },
  { action: 'assertCount', target: 'task-item', expected: 1 },
  { action: 'assertVisible', target: 'task-item' },
];
export const targets = {
  'todo-good': ['task-input', 'task-item', 'add-button', 'task-list'],
  'todo-noop': ['task-input', 'task-item', 'add-button', 'task-list'],
  'counter-good': ['counter-value', 'increment-button'],
  'security-probe': ['run-probe', 'probe-output', 'top-nav', 'self-nav'],
  'cpu-loop': ['burn-button', 'burn-result'],
};
export const plans = {
  'todo-good': { schemaVersion: '0.1', id: 'todo-add', specId: 'spike-todo', tests: [{ requirementId: 'R1', steps: todoSteps }] },
  'todo-noop': { schemaVersion: '0.1', id: 'todo-add', specId: 'spike-todo', tests: [{ requirementId: 'R1', steps: todoSteps }] },
  'counter-good': { schemaVersion: '0.1', id: 'counter-increment', specId: 'spike-counter', tests: [{ requirementId: 'R1', steps: [{ action: 'assertValue', target: 'counter-value', expected: '0' }, { action: 'click', target: 'increment-button' }, { action: 'assertValue', target: 'counter-value', expected: '1' }] }] },
  'security-probe': { schemaVersion: '0.1', id: 'security-harmless-markers', specId: 'spike-security', tests: [{ requirementId: 'R1', steps: [{ action: 'click', target: 'run-probe' }, { action: 'assertVisible', target: 'probe-output' }] }] },
  'cpu-loop': { schemaVersion: '0.1', id: 'bounded-cpu-loop', specId: 'spike-resource', tests: [{ requirementId: 'R1', steps: [{ action: 'click', target: 'burn-button' }, { action: 'assertValue', target: 'burn-result', expected: 'done' }] }] },
};
export class InvalidPlan extends Error { constructor(message) { super(message); this.name = 'InvalidPlan'; } }
const exact = (object, keys, required) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(object, key));
export function validateJob(job) {
  if (!exact(job, ['schemaVersion', 'jobId', 'fixture', 'presentation', 'testPlan', 'probe'], ['schemaVersion', 'jobId', 'fixture', 'presentation', 'testPlan']) || job.schemaVersion !== '0.1' || !/^[a-zA-Z0-9-]{1,100}$/.test(job.jobId) || !Object.hasOwn(targets, job.fixture) || !['direct', 'iframe'].includes(job.presentation) || !['none', 'preview-unavailable', 'browser-crash', 'preview-disconnect', 'resource-timeout'].includes(job.probe || 'none')) throw new InvalidPlan('Job envelope rejected');
  const plan = job.testPlan;
  if (!exact(plan, ['schemaVersion', 'id', 'specId', 'tests'], ['schemaVersion', 'id', 'specId', 'tests']) || plan.schemaVersion !== '0.1' || plan.id !== plans[job.fixture].id || plan.specId !== plans[job.fixture].specId || !Array.isArray(plan.tests) || plan.tests.length !== 1) throw new InvalidPlan('Test plan identity rejected');
  const requirement = plan.tests[0];
  if (!exact(requirement, ['requirementId', 'steps'], ['requirementId', 'steps']) || requirement.requirementId !== 'R1' || !Array.isArray(requirement.steps) || requirement.steps.length < 1 || requirement.steps.length > 20) throw new InvalidPlan('Requirement or step count rejected');
  for (const step of requirement.steps) {
    if (!exact(step, ['action', 'target', 'value', 'expected', 'timeoutMs'], ['action', 'target']) || !['fill', 'click', 'assertVisible', 'assertAbsent', 'assertCount', 'assertValue'].includes(step.action) || !targets[job.fixture].includes(step.target)) throw new InvalidPlan('Unknown action, target or field');
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 5000)) throw new InvalidPlan('Step timeout rejected');
    if (step.action === 'fill') { if (step.value !== unique || Object.hasOwn(step, 'expected')) throw new InvalidPlan('Fill accepts only the runtime unique placeholder'); }
    else if (Object.hasOwn(step, 'value')) throw new InvalidPlan('Unexpected value field');
    if (step.action === 'assertCount' && (!Number.isInteger(step.expected) || step.expected < 0 || step.expected > 100)) throw new InvalidPlan('Invalid count');
    if (step.action === 'assertValue' && (typeof step.expected !== 'string' || step.expected.length > 128)) throw new InvalidPlan('Invalid expected value');
    if (!['assertCount', 'assertValue'].includes(step.action) && Object.hasOwn(step, 'expected')) throw new InvalidPlan('Unexpected expected field');
  }
  return job;
}
