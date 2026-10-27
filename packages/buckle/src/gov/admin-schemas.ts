// src/gov/admin-schemas.ts — W1238.4: zod v4 schemas for the /v1/admin/*
// POST bodies the gate consumes. One source of truth for the wire shape:
// gov/admin.ts never hand-casts `read.body as Record<string, unknown>` —
// it safeParses through these, so a payload-shape drift fails LOUD (a 400
// with the parse error) instead of silently coercing into a malformed
// row. Same doctrine as suspenders remotes.ts (W308) and the copilot
// dialect schemas (W296). First slice of the stack-wide schema-first
// adoption (root AGENTS.md, Schema law): buckle gate bodies → belt router
// payloads → hubctl render env.
import { z } from "zod";

/** Present-and-non-empty string: the str() contract it replaces. */
const nonEmpty = z.string().min(1);
/** Present-and-finite number: the num() contract it replaces. */
const finite = z.number().finite();

// W141 POST /v1/admin/drain {reason, grace_ms?} — grace_ms clamps in code
// (policy, not shape).
export const AdminDrainSchema = z.object({
	reason: nonEmpty,
	grace_ms: finite.optional(),
});

// W141 POST /v1/admin/keys/verify {key}
export const AdminVerifySchema = z.object({
	key: nonEmpty,
});

// W141 POST /v1/admin/keys {name, scopes?, team?, rpm_limit?, tpm_limit?,
// expires_in_s?} — scopes default to [] when absent; a non-string entry
// REJECTS (400) where the old hand-parse silently dropped it: fail loud
// is the law, silent coercion was the hazard.
export const AdminIssueKeySchema = z.object({
	name: nonEmpty,
	scopes: z.array(z.string()).default([]),
	team: nonEmpty.optional(),
	rpm_limit: finite.optional(),
	tpm_limit: finite.optional(),
	expires_in_s: finite.optional(),
});

// W173 POST /v1/admin/spokes/enroll {spoke_id, ttl_s?}
export const AdminEnrollSchema = z.object({
	spoke_id: nonEmpty,
	ttl_s: finite.optional(),
});

// W141 POST /v1/admin/teams {team_id, name?, department?, ceilings?} —
// name falls back to team_id in code (policy, not shape).
export const AdminTeamSchema = z.object({
	team_id: nonEmpty,
	name: nonEmpty.optional(),
	department: nonEmpty.optional(),
	rpm_ceiling: finite.optional(),
	tpm_ceiling: finite.optional(),
	spend_ceiling: finite.optional(),
});

export type AdminDrainBody = z.infer<typeof AdminDrainSchema>;
export type AdminVerifyBody = z.infer<typeof AdminVerifySchema>;
export type AdminIssueKeyBody = z.infer<typeof AdminIssueKeySchema>;
export type AdminEnrollBody = z.infer<typeof AdminEnrollSchema>;
export type AdminTeamBody = z.infer<typeof AdminTeamSchema>;
