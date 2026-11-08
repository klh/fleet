export interface RunnerDiagnostic {
	type: "runner.error";
	traceId: string;
	operation: string;
	phase: RunnerPhase;
	errorClass: "TypeError" | "RangeError" | "Error" | "Unknown";
}

/** No exception messages, stack traces, request headers or provider bodies. */
export function reportRunnerFailure(
	request: Request,
	error: unknown,
	traceId: string,
	phase: RunnerPhase,
	callback?: (event: RunnerDiagnostic) => void,
) {
	const path = new URL(request.url).pathname;
	const actions = new Set([
		"submit",
		"resume",
		"abort",
		"attach",
		"replay",
		"detach",
		"fence",
	]);
	const tail = path.split("/").at(-1) ?? "";
	const operation =
		path === "/v1/runner/runs"
			? request.method === "GET"
				? "list"
				: "admit"
			: actions.has(tail)
				? tail
				: /^\/v1\/runner\/runs\/[^/]+$/.test(path)
					? "read"
					: "unknown";
	const event: RunnerDiagnostic = {
		type: "runner.error",
		traceId,
		operation,
		phase,
		errorClass:
			error instanceof TypeError
				? "TypeError"
				: error instanceof RangeError
					? "RangeError"
					: error instanceof Error
						? "Error"
						: "Unknown",
	};
	try {
		if (callback) callback(event);
		else console.error(JSON.stringify(event));
	} catch {
		/* Diagnostic sinks cannot change the action's response. */
	}
}

export type RunnerPhase = "identity" | "route";
