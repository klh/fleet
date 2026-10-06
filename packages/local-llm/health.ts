/** Process liveness only; outside-process sidecars own service health. */
export function livenessResponse(
	req: Request,
	service: string,
	details: Record<string, string> = {},
): Response | null {
	if (
		!["/health", "/health/liveness", "/health/liveliness"].includes(
			new URL(req.url).pathname,
		)
	)
		return null;
	const headers = {
		"cache-control": "no-store",
		"content-type": "application/json",
		allow: "GET, HEAD, OPTIONS",
	};
	if (req.method === "OPTIONS")
		return new Response(null, { status: 204, headers });
	if (req.method !== "GET" && req.method !== "HEAD")
		return new Response(null, { status: 405, headers });
	return new Response(
		req.method === "HEAD"
			? null
			: JSON.stringify({
					ok: true,
					status: "alive",
					service,
					check: "process-liveness",
					...details,
				}),
		{ headers },
	);
}

/** Respect explicit health failures without buffering arbitrary model payloads. */
export async function endpointPassed(response: Response): Promise<boolean> {
	if (!response.ok) {
		await response.body?.cancel();
		return false;
	}
	if (!response.headers.get("content-type")?.includes("json")) {
		await response.body?.cancel();
		return true;
	}
	const reader = response.body?.getReader();
	if (!reader) return response.status === 204 || response.status === 205;
	const decoder = new TextDecoder();
	let body = "";
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 65_536) return false;
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
		if (!body.trim()) return false;
		const value = JSON.parse(body);
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return false;
		return (
			value?.ok !== false &&
			value?.healthy !== false &&
			![
				"down",
				"unhealthy",
				"error",
				"failed",
				"unavailable",
				"dead",
				"stopped",
				"degraded",
			].includes(value?.status)
		);
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
