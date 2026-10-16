import type {Requirement,TestStep} from './contracts.ts';
export type PlanOrigin='REAL_LLM_PLAN'|'CONTROLLED_TEST_PLAN'|'UNKNOWN_ORIGIN';
export interface DisplayStep {action:string;target:string;dataRef?:string;optionRef?:string;expected?:unknown;expectedText?:string;expectedRef?:string;timeoutMs?:number;value?:string}
export interface EvidenceView {
  schemaVersion:'M2-C-1';identityValid:boolean;missingReason:string|null;
  projectId:string;specId:string;versionId:string;planId:string|null;protocol:'0.1'|'1.1';
  planState:string;origin:{kind:PlanOrigin;explanation:string;proofId?:string;proofSha256?:string;providerRequestId?:string};
  expandedSteps:number|null;
  requirements:{requirement:Requirement;coverage:string;reason:string;explanation:string;steps:DisplayStep[];setup:{id:string;sourceRequirementId:string;steps:DisplayStep[]}|null}[];
  authorization:{id:string;hash:string;decision:string;policyVersion:string}|null;
  humanAcceptance:{accepted:boolean;createdAt:string|null};
}
