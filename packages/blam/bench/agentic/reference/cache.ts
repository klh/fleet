interface CacheRecord {
	lane: string | null;
	model: string;
	support: "supported" | "unsupported" | "unknown";
	readTokens: number | null;
	writeTokens: number | null;
}
interface CacheSummary {
	requests: number;
	known: number;
	warm: number;
	readTokens: number;
	writeTokens: number;
	state: "no-traffic" | "unsupported" | "unknown" | "measured";
}

export function summarizeCache(
	records: CacheRecord[],
	lane: string,
	model: string,
): CacheSummary {
	const rows = records.filter(
		(row) => row.lane === lane && row.model === model,
	);
	if (rows.length === 0)
		return {
			requests: 0,
			known: 0,
			warm: 0,
			readTokens: 0,
			writeTokens: 0,
			state: "no-traffic",
		};
	if (rows.every((row) => row.support === "unsupported"))
		return {
			requests: rows.length,
			known: 0,
			warm: 0,
			readTokens: 0,
			writeTokens: 0,
			state: "unsupported",
		};
	const known = rows.filter(
		(row) =>
			row.support === "supported" &&
			typeof row.readTokens === "number" &&
			row.readTokens >= 0,
	);
	return {
		requests: rows.length,
		known: known.length,
		warm: known.filter((row) => (row.readTokens ?? 0) > 0).length,
		readTokens: known.reduce((n, row) => n + (row.readTokens ?? 0), 0),
		writeTokens: known.reduce((n, row) => n + (row.writeTokens ?? 0), 0),
		state: known.length > 0 ? "measured" : "unknown",
	};
}
