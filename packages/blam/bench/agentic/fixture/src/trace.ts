export function nextTrace(
	parent: string | null,
	generatedTraceId: string,
	nextSpanId: string,
): string {
	const traceId = parent?.split("-")[1] ?? generatedTraceId;
	return `00-${traceId}-${nextSpanId}-01`;
}
