const traceId = (value: string): boolean =>
	/^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value);
const spanId = (value: string): boolean =>
	/^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value);

export function nextTrace(
	parent: string | null,
	generatedTraceId: string,
	nextSpanId: string,
): string {
	if (!traceId(generatedTraceId) || !spanId(nextSpanId))
		throw new Error("invalid supplied ID");
	const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(
		parent ?? "",
	);
	const valid = match && traceId(match[1]) && spanId(match[2]);
	const id = valid ? match[1] : generatedTraceId;
	const flags = valid ? match[3] : "01";
	return `00-${id.toLowerCase()}-${nextSpanId.toLowerCase()}-${flags.toLowerCase()}`;
}
