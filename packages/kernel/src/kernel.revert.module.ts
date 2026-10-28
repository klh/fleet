// kernel.revert.module.ts — W1868: the C156 revert classifier + landing
// rule, promoted from proven twins (W1476's review-evals.ts,
// W1477's review-guardrail.ts). Pure: subject+body in, {reverts|null} out;
// null = not a revert, or a re-land (`Revert "Revert ` / git>=2.43
// `Reapply "` re-lands the original — no incident). The landing rule's
// ancestor check (was the named target on the integration line before the
// revert landed?) stays an INJECTED predicate so kernel imports nothing in
// fleet.

/** C156 classification: `reverts` names the reverted 40-hex commit (null
 *  when only the subject says so). Null = not a revert, or a re-land. */
export interface RevertClassification {
	reverts: string | null;
}

const RELAND_SUBJECT = /^(?:Revert "Revert |Reapply ")/;
const REVERT_SUBJECT = /^Revert "/;
const REVERTS_BODY = /This reverts commit ([0-9a-f]{40})/;

/** C156 pure classifier: a revert names its target (the body's 40-hex,
 *  null when only the subject says so); null = not a revert, or a re-land. */
export function classifyRevert(
	subject: string,
	body: string,
): RevertClassification | null {
	if (RELAND_SUBJECT.test(subject)) return null;
	const named = REVERTS_BODY.exec(body)?.[1];
	if (named) return { reverts: named };
	return REVERT_SUBJECT.test(subject) ? { reverts: null } : null;
}

/** The C156 landing rule: a named revert counts only when the injected
 *  predicate says its target sat on the integration line before the landing
 *  (false = branch-internal undo, dropped; unknown objects — a predicate
 *  that cannot tell — stay reverts). A subject-only revert (reverts=null)
 *  counts unconditionally. */
export function isRevertLanding(
	subject: string,
	body: string,
	isAncestor: (reverts: string) => boolean,
): RevertClassification | null {
	const hit = classifyRevert(subject, body);
	if (!hit) return null;
	if (hit.reverts && !isAncestor(hit.reverts)) return null;
	return hit;
}
