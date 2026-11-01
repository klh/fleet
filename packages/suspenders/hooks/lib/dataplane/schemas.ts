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
