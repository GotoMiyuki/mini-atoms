# v1.1 strict schema and negative matrix

Normative executable schema: `apps/builder/src/shared/protocol-v11.mjs` (`parseProposal`, `parseStep`). All objects reject unknown keys. Limits: 64 KiB, 8 tests/setups, test 1–10 steps, setup 1–5 steps, expanded Run ≤20; testid `[a-z][a-z0-9-]{0,63}`, UUID identities, SHA-256 hashes, timeout integer 100–5000 ms.

| Action | Required beyond action,target | Optional | Forbidden/negative |
|---|---|---|---|
| fill | dataRef enum | timeoutMs | literal value, unknown ref |
| click | — | timeoutMs | selector, URL, script, submit/upload |
| selectOption | optionRef | timeoutMs | non-static option, arbitrary value |
| assertVisible / assertAbsent | — | timeoutMs | expected, selector |
| assertCount | expected integer 0–100 | timeoutMs | negative/fraction/string |
| assertTextContains / assertInputValue | exactly one expectedText/expectedRef | timeoutMs | both/neither; templates; unknown ref; >128 chars |
| assertChecked | expected boolean | timeoutMs | string boolean, non-checkbox |

Proposal required: protocolVersion=1.1, specId, appVersionId, source/build/configSha256, setupBundles, tests. Optional coverage has requirementId/reason/explanation, never a verdict. Setup exact id/sourceRequirementId/purpose/steps and optional documentary capabilityTag. Test exact requirementId/acceptanceClaim/steps and optional one-layer setupRef. `acceptanceClaim` is an exact substring of frozen acceptance, with no completeness authority. Authorization IDs, decision, hashes, scripts and paths are forbidden in proposal.

Offline tests cover missing/version/unknown field/fake ALLOW/forged artifact; identities; separate source and TEST scopes; missing/duplicate/type/effects; recursive/unknown reference/self dependency; conflicting prestate; replay cost 21; arbitrary action/selector/upload; bad refs/XOR/random templates; false model budget explanation. Legitimate tests invoke the actual deterministic authorizer; no fixture is handed a prebuilt ALLOW.

Runtime and product matrices P01–P23 and their raw outputs are mapped in the implementation report. An offline test passing is not evidence of browser execution.
