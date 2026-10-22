type AnyRec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function upstreamErrorDetail(
	wire: unknown,
	fallback = "upstream stream error",
): {
	message: string;
	type: string;
	code?: string | number;
	trace_id?: string;
} {
	const records: AnyRec[] = [];
	let cursor = wire;
	for (
		let depth = 0;
		depth < 5 && cursor && typeof cursor === "object" && !Array.isArray(cursor);
		depth++
	) {
		const record = cursor as AnyRec;
		records.unshift(record);
		cursor = record.error ?? record.cause;
	}
	const clean = (value: string): string =>
		value
			.slice(0, 4096)
			.replace(/\/Users\/[^/\s'"]+/g, "~")
			.replace(/\b(?:sk-|bksk_|ghp_)[A-Za-z0-9_-]+/g, "[redacted]")
			.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
			.slice(0, 1024);
	const pick = (...keys: string[]): string => {
		for (const record of records)
			for (const key of keys) {
				const value = str(record[key]);
				if (value.trim()) return clean(value);
			}
		return "";
	};
	const rawType = pick("type");
	const code = records
		.map((record) => record.code)
		.find(
			(value) =>
				typeof value === "string" ||
				(typeof value === "number" && Number.isFinite(value)),
		);
	const trace = pick("trace_id", "traceId");
	return {
		message: pick("message", "detail", "why", "title") || fallback,
		type:
			rawType &&
			!["error", "response.failed", "response.incomplete"].includes(rawType) &&
			!rawType.includes("://")
				? rawType
				: "api_error",
		...(typeof code === "string"
			? { code: clean(code) }
			: typeof code === "number"
				? { code }
				: {}),
		...(trace ? { trace_id: trace } : {}),
	};
}
