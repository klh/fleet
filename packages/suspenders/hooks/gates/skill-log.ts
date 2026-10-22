// hooks/gates/skill-log.ts — W1144: the PreToolUse Skill matcher. One job:
// append one NDJSON invocation line (lib/skill-usage.ts) and allow. There is
// deliberately NO deny path — this is instrumentation, not a gate; the
// 2026-09-03 parking cleanup retired 30 skills on retroactive usage
// evidence, and this log is that evidence collected live. Advisory law:
// any failure stays silent (append swallows, allow() always runs).
// SUSPENDERS_SKILL_LOG=0 disables the append (the report face still reads
// whatever was logged before).
import { allow, type HookInput } from "../lib/hookio.ts";
import { appendSkillInvocation, shouldLogSkill } from "../lib/skill-usage.ts";

export function skillLogGate(hook: HookInput): never {
	if (shouldLogSkill()) appendSkillInvocation(hook);
	allow();
}
