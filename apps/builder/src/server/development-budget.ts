import {AppError} from '../shared/contracts.ts';
import type {Job} from '../shared/contracts.ts';

// Supplied only by the local acceptance controller, never configuration/env/HTTP.
export type DevelopmentBudget=Readonly<{id:string;utcDay:string;limit:6|4;scopes:readonly Readonly<{projectId:string;specId:string|null;task:NonNullable<Job['task']>;versionId:string|null}>[]}>;
export function developmentOrigin(budget:DevelopmentBudget,scope:{projectId:string;specId:string|null;task:NonNullable<Job['task']>;versionId:string|null}){
  const original=/^m1\.1-completion-\d{4}-\d\d-\d\d$/.test(budget.id)&&budget.limit===6&&budget.id===`m1.1-completion-${budget.utcDay}`;
  const m2=budget.id===`m2-b-${budget.utcDay}`&&budget.limit===4&&scope.task==='PLAN'&&['8445f9d9-2744-4705-a1fd-19896bbcb279','85968b70-834e-4bf0-a732-d2ebc6b2f78b','ce8530d9-f3c9-4dbf-a3ad-c342e13e4d33'].includes(scope.versionId||'');
  if(!(original||m2)||budget.utcDay!==new Date().toISOString().slice(0,10)||!budget.scopes.some(s=>s.projectId===scope.projectId&&s.specId===scope.specId&&s.task===scope.task&&s.versionId===scope.versionId))throw new AppError('DEVELOPMENT_BUDGET','开发验收预算过期或任务不在授权范围',403);
  return `DEV_ACCEPTANCE:${budget.id}`;
}
