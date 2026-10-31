// schemas.ts — W2327: the dataplane's ONE wire vocabulary (schema law
// W1238.4): every request body safeParses through a named zod Schema, never
// a hand cast. One request shape covers List (collection-shaped), one per
// Get (name-keyed); resource modules parse and own their field maps.
import { z } from "zod";

/** List request shared by every collection (AIP-132/158 pagination). */
export const ListRequestSchema = z.object({
	page_size: z.number().int().min(1).max(500).optional(),
	page_token: z.string().min(1).max(256).optional(),
	filter: z.string().min(1).max(2_000).optional(),
	order_by: z.string().min(1).max(200).optional(),
});
export type ListRequest = z.output<typeof ListRequestSchema>;

/** Get request shared by every resource (AIP-131 name-keyed). */
export const GetRequestSchema = z.object({
	name: z.string().min(1).max(512),
});

/** List response shared by every collection: rows + opaque keyset cursor. */
export interface ListResponse<T> {
	items: T[];
	next_page_token: string | null;
}

export const parseListRequest = (
	body: unknown,
): { ok: true; req: ListRequest } | { ok: false; error: string } => {
	const parsed = ListRequestSchema.safeParse(body);
	return parsed.success
		? { ok: true, req: parsed.data }
		: { ok: false, error: z.prettifyError(parsed.error) };
};

export const parseGetRequest = (
	body: unknown,
): { ok: true; name: string } | { ok: false; error: string } => {
	const parsed = GetRequestSchema.safeParse(body);
	return parsed.success
		? { ok: true, name: parsed.data.name }
		: { ok: false, error: z.prettifyError(parsed.error) };
};

// ---- v0.1 writes (W2328) --------------------------------------------------

/** WorkItems/Create (AIP-133): title required; the add-verb surface. */
export const CreateWorkItemRequestSchema = z.object({
	title: z.string().min(1).max(2_000),
	parent: z
		.string()
		.regex(/^W[\d.]+$/)
		.optional(),
	priority: z.number().int().min(0).max(100).optional(),
	tags: z.array(z.string().min(1).max(64)).max(16).optional(),
	description: z.string().max(8_000).optional(),
	scope: z.string().max(200).optional(),
	reason: z.string().max(2_000).optional(),
	evidence: z.string().max(2_000).optional(),
});
export type CreateWorkItemRequest = z.output<
	typeof CreateWorkItemRequestSchema
>;

/** WorkItems/Update (AIP-134): name-keyed, update_mask'd (the four mutable
 *  fields), reason rides work.edited. */
export const UpdateWorkItemRequestSchema = z.object({
	name: z.string().min(1).max(512),
	update_mask: z.array(z.string().min(1).max(64)).max(8).optional(),
	title: z.string().min(1).max(2_000).optional(),
	description: z.string().max(8_000).optional(),
	priority: z.number().int().min(0).max(100).optional(),
	tags: z.array(z.string().min(1).max(64)).max(16).optional(),
	reason: z.string().max(2_000).optional(),
});
export type UpdateWorkItemRequest = z.output<
	typeof UpdateWorkItemRequestSchema
>;

/** WorkItems/Delete (AIP-135, soft): name-keyed CANCELLED transition. */
export const DeleteWorkItemRequestSchema = z.object({
	name: z.string().min(1).max(512),
	note: z.string().max(2_000).optional().default(""),
});
export type DeleteWorkItemRequest = z.output<
	typeof DeleteWorkItemRequestSchema
>;

/** Lanes/Message + Lanes/Steer (custom methods, AIP-136): name-keyed directed
 *  input. Message carries an optional urgent class; Steer rides the verb's
 *  own gates, not dataplane policy. */
const LaneWriteRequestSchema = z.object({
	name: z.string().min(1).max(512),
	text: z.string().min(1).max(8_000),
	source: z.string().max(200).optional(),
});
export const LaneMessageRequestSchema = LaneWriteRequestSchema.extend({
	urgent: z.boolean().optional(),
});
export const LaneSteerRequestSchema = LaneWriteRequestSchema;
export type LaneMessageRequest = z.output<typeof LaneMessageRequestSchema>;
export type LaneSteerRequest = z.output<typeof LaneSteerRequestSchema>;
