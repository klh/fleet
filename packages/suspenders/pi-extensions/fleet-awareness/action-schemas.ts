import { z } from "zod";
const text = z
	.string()
	.trim()
	.min(1)
	.max(8000)
	.refine((s) => !s.startsWith("-"), "text must not begin with a CLI option");
const item = z
	.string()
	.regex(/^W\d+(?:\.\d+)*$/)
	.max(100);
export const ActionSchema = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("snapshot") }),
	z.strictObject({ action: z.literal("peers") }),
	z.strictObject({ action: z.literal("consults") }),
	z.strictObject({ action: z.literal("item"), id: item }),
	z.strictObject({ action: z.literal("knowledge"), query: text }),
	z.strictObject({
		action: z.literal("consult"),
		target: text,
		question: text,
		scope: text.optional(),
	}),
	z.strictObject({
		action: z.literal("reply"),
		consult: z.string().regex(/^C[1-9]\d*$/),
		answer: text,
		version: text.optional(),
	}),
	z.strictObject({
		action: z.literal("feedback"),
		consult: z.string().regex(/^C[1-9]\d*$/),
		outcome: z.enum(["resolved", "failed", "unused"]),
		evidence: text,
	}),
	z.strictObject({
		action: z.literal("ack"),
		event: z.number().int().positive(),
		acted: text,
	}),
]);
export type Action = z.infer<typeof ActionSchema>;
export const ActionResultSchema = z.strictObject({
	state: z.enum(["ok", "queued", "refused", "unavailable", "invalid"]),
	actor: z.string().nullable(),
	data: z.json(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
export const KnowledgeSchema = z
	.object({
		schema_version: z.literal(1),
		verb: z.literal("kb"),
		sub: z.literal("search"),
		match: z
			.object({
				id: z.number().int(),
				problem: z.string(),
				solution: z.string(),
				answeredBy: z.string(),
				hits: z.number(),
			})
			.strip()
			.nullable(),
	})
	.strip();
export const ConsultsSchema = z
	.object({
		schema_version: z.literal(1),
		verb: z.literal("consults"),
		consults: z
			.array(
				z
					.object({
						cid: z.string(),
						state: z.string(),
						readerState: z.string().nullable().optional(),
						askerSid: z.string(),
						question: z.string(),
						answer: z.string().nullable(),
					})
					.strip(),
			)
			.max(100),
	})
	.strip();
export const ItemSchema = z
	.object({
		id: item,
		title: z.string(),
		description: z.string().nullable(),
		state: z.string(),
		fail_reason: z.string().nullable(),
		owner_sid: z.string().nullable(),
		result_sha: z.string().nullable(),
		completion: z
			.object({ summary: z.string(), commit_sha: z.string() })
			.strip()
			.nullable(),
	})
	.strip();
