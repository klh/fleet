import { z } from "zod";

export function runnerOutput(
	operation: string,
	value: unknown,
	ndjson: boolean,
	json: boolean,
) {
	if (!ndjson) {
		console.log(JSON.stringify(value, null, json ? undefined : 2));
		return;
	}
	const data = z.record(z.string(), z.unknown()).parse(value);
	const rows = Array.isArray(data.runs)
		? data.runs
		: Array.isArray(data.events)
			? data.events
			: null;
	if (rows) {
		for (const row of rows)
			console.log(
				JSON.stringify({
					version: 1,
					type: Array.isArray(data.runs) ? "run" : "event",
					operation,
					data: row,
				}),
			);
	} else
		console.log(
			JSON.stringify({ version: 1, type: "result", operation, data }),
		);
	console.log(
		JSON.stringify({
			version: 1,
			type: "complete",
			operation,
			ok: true,
			count: rows?.length ?? 1,
			cursor: data.cursor ?? data.nextCursor ?? null,
		}),
	);
}
