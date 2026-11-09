import {
	adminKey,
	hubCredential,
} from "@klh/suspenders/hooks/lib/lanes/lane-auth.ts";
import { z } from "zod";

const LedgerRowSchema = z
	.object({
		rid: z.string(),
		lane: z.string(),
		status: z.number().nullable(),
		ok: z.number().nullable(),
		served_model: z.string().nullable(),
		served_provider: z.string().nullable(),
		target_model: z.string().nullable(),
		dialect: z.string(),
		in_tok: z.number().nonnegative().nullable(),
		out_tok: z.number().nonnegative().nullable(),
		cache_r: z.number().nonnegative().nullable(),
		cache_c: z.number().nonnegative().nullable(),
		cache_reported: z.number().nullable(),
	})
	.strip();
const LedgerResponseSchema = z
	.object({ requests: z.array(LedgerRowSchema) })
	.loose();

/** Read only the unique job's audit rows; never open a live ledger SQLite file. */
export async function routeLedger(
	front: string,
	hub: string | null,
	job: string,
	fetchFn: typeof fetch = fetch,
) {
	const admin = hub ? hubCredential(hub) : adminKey();
	if (!admin) return null;
	const url = new URL(`${front}/v1/admin/requests`);
	url.searchParams.set("lane", job);
	url.searchParams.set("limit", "5");
	try {
		const response = await fetchFn(url, {
			headers: { authorization: `Bearer ${admin}` },
			signal: AbortSignal.timeout(5000),
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		const result = LedgerResponseSchema.safeParse(await response.json());
		if (!result.success) return null;
		const rows = result.data.requests.filter(
			(r) => r.lane === job && r.status !== null,
		);
		return rows.length === 1 ? rows[0] : null;
	} catch {
		return null;
	}
}
