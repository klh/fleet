export interface CacheRecord {
	lane: string | null;
	model: string;
	support: "supported" | "unsupported" | "unknown";
	readTokens: number | null;
	writeTokens: number | null;
}

export interface CacheSummary {
	requests: number;
	known: number;
	warm: number;
	readTokens: number;
	writeTokens: number;
	state: "no-traffic" | "unsupported" | "unknown" | "measured";
}

export function summarizeCache(
	records: CacheRecord[],
	// biome-ignore lint/correctness/noUnusedFunctionParameters: deliberate bug in the starting fixture
	lane: string,
	model: string,
): CacheSummary {
	const rows = records.filter((row) => row.model === model);
	return {
		requests: rows.length,
		known: rows.length,
		warm: rows.filter((row) => (row.readTokens ?? 0) > 0).length,
		readTokens: rows.reduce((sum, row) => sum + (row.readTokens ?? 0), 0),
		writeTokens: rows.reduce((sum, row) => sum + (row.writeTokens ?? 0), 0),
		state: rows.length ? "measured" : "no-traffic",
	};
}
