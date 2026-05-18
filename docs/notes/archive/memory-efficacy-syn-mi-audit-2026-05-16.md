# syn-mi-* audit

Total synthetic `memory_ignored` rows: 15
Borderline: 4
Clear-cut: 11

| findingId | reason | verdict | justification |
| --- | --- | --- | --- |
| syn-mi-001 | Relevant memory is recalled but truncated during context assembly so it is not actually used. | KEEP | The memory is surfaced and then damaged in-context, which fits `memory_ignored`. |
| syn-mi-002 | The system recalls memory but puts it in a disabled prompt section that the agent never receives. | KEEP | Recall happened, but the agent still received the wrong prompt shape, so this remains an ignore case. |
| syn-mi-003 | Retrieved memory is present but deprioritized to effectively unusable position in final context. | KEEP | The memory reaches the final context and is simply buried. |
| syn-mi-004 | Recalled content is stripped of meaningful rationale before dispatch, so guidance is disregarded. | KEEP | The recalled item still reaches dispatch; the issue is loss of signal quality. |
| syn-mi-005 | Memory is recalled but transformed into generic text that no longer influences downstream decisions. | KEEP | This is recall plus degradation, not a missing recall. |
| syn-mi-006 | The recall result is fetched but key fields are dropped, so the memory signal is not respected. | KEEP | The pipeline surfaced the memory and then stripped fields from it. |
| syn-mi-007 | Token-pruning keeps lower-value text while cutting recalled memory, which nullifies retrieved context. | KEEP | The memory was retrieved; pruning then erased its effect. |
| syn-mi-008 | Recall appears in preview but is absent in actual worker prompt, meaning fetched memory is ignored. | RELABEL_TO_RECALL_MISS | The reason says the worker never sees the memory in the executed prompt. |
| syn-mi-009 | Hydration returns relevant memory but downstream dedup removes the actionable item before use. | KEEP | Hydration succeeded and the failure is downstream handling. |
| syn-mi-010 | The recalled block is dropped during adapter conversion, so retrieved memory never reaches inference. | RELABEL_TO_RECALL_MISS | Adapter conversion failure prevents the model from ever seeing the recalled block. |
| syn-mi-011 | Conflict resolution overrides recalled guidance with defaults, so the memory is effectively disregarded. | KEEP | The memory is present in the conflict set and then overwritten. |
| syn-mi-012 | Transport metadata shows recall happened, but payload narrowing drops the recalled body before execution. | RELABEL_TO_RECALL_MISS | The executed payload never includes the recalled body. |
| syn-mi-013 | Recalled context is available but planner logic skips it in auto mode, so it is not applied. | KEEP | The memory reaches planning and is intentionally ignored. |
| syn-mi-014 | Sanitization leaves recalled memory too redacted to be actionable, so the model ignores it. | KEEP | The memory still arrives; sanitization makes it unusable. |
| syn-mi-015 | Prompt delimiters place recalled memory in a segment excluded from model-consumed input. | RELABEL_TO_RECALL_MISS | The boundary prevents the model from consuming the recalled segment at all. |

Relabel proposal:

```json
["syn-mi-008","syn-mi-010","syn-mi-012","syn-mi-015"]
```
