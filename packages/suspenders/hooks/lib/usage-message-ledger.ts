import type { Database } from "bun:sqlite";

type Meter = {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cache_read_input_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
};
type Snapshot = {
	hour_bucket: number;
	actor: string;
	model: string;
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
};
const amount = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;

/** Usage snapshots repeat across assistant content blocks. Charge only growth
 * against a durable source/message identity, inside the caller transaction. */
export function usageMessageLedger(
	db: Database,
	table:
		| "usage_message_ledger"
		| "usage_verified_message_ledger" = "usage_message_ledger",
) {
	if (
		table !== "usage_message_ledger" &&
		table !== "usage_verified_message_ledger"
	)
		throw new Error("invalid usage ledger source");
	db.run(
		`CREATE TABLE IF NOT EXISTS ${table} (source TEXT NOT NULL, message_id TEXT NOT NULL, hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, cache_r INTEGER NOT NULL, cache_c INTEGER NOT NULL, PRIMARY KEY(source,message_id))`,
	);
	const read = db.query(
		`SELECT * FROM ${table} WHERE source=? AND message_id=?`,
	);
	const save = db.query(
		`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source,message_id) DO UPDATE SET in_tok=excluded.in_tok,out_tok=excluded.out_tok,cache_r=excluded.cache_r,cache_c=excluded.cache_c`,
	);
	return (
		source: string,
		messageId: string,
		hour: number,
		actor: string,
		model: string,
		usage: Meter,
	) => {
		const old = read.get(source, messageId) as Snapshot | null;
		const values = [
			amount(usage.input_tokens),
			amount(usage.output_tokens),
			amount(usage.cache_read_input_tokens),
			amount(usage.cache_creation_input_tokens),
		];
		const previous = [
			old?.in_tok ?? 0,
			old?.out_tok ?? 0,
			old?.cache_r ?? 0,
			old?.cache_c ?? 0,
		];
		const next = values.map((v, i) => Math.max(v, previous[i]));
		const delta = next.map((v, i) => v - previous[i]);
		const identity = {
			hour: old?.hour_bucket ?? hour,
			actor: old?.actor ?? actor,
			model: old?.model ?? model,
		};
		save.run(
			source,
			messageId,
			identity.hour,
			identity.actor,
			identity.model,
			...next,
		);
		return {
			...identity,
			requests: old ? 0 : 1,
			usage: {
				input_tokens: delta[0],
				output_tokens: delta[1],
				cache_read_input_tokens: delta[2],
				cache_creation_input_tokens: delta[3],
			},
		};
	};
}
