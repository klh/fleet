import { ZodError } from "zod";
import { RunnerAuthError } from "../control/rights.ts";
import { reportRunnerFailure } from "./diagnostics.ts";
import { runnerRoute } from "./routes.ts";
import type { RunnerApiDependencies } from "./types.ts";

const statuses: Readonly<Record<string, number>> = {
	"runner.unauthorized": 401,
	"runner.identity_unavailable": 503,
	"runner.forbidden": 403,
	"runner.not_found": 404,
	"runner.method_not_allowed": 405,
	"runner.invalid_profile": 400,
	"runner.body_too_large": 413,
	"runner.body_timeout": 408,
	"runner.invalid_body": 400,
	"runner.request_conflict": 409,
};
export function createRunnerApi(deps: RunnerApiDependencies) {
	const hosts = new Set(
		deps.allowedHosts ?? ["localhost:7810", "127.0.0.1:7810"],
	);
	return {
		async fetch(request: Request): Promise<Response> {
			const traceId = crypto.randomUUID();
			let phase: "identity" | "route" = "identity";
			const headers = {
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"x-runner-trace-id": traceId,
			};
			try {
				if (
					!hosts.has(new URL(request.url).host) ||
					request.headers.has("origin") ||
					(request.headers.has("host") &&
						!hosts.has(request.headers.get("host") ?? ""))
				)
					throw new Error("runner.forbidden");
				// W2880: unauthenticated liveness face for the independent
				// health sidecar (services.yaml runner-control-health) — it
				// polls over the wire with no credential, so identity stays
				// off the health leg and an expired key can never break
				// liveness reporting.
				if (
					request.method === "GET" &&
					new URL(request.url).pathname === "/v1/runner/health"
				)
					return Response.json({ ok: true }, { status: 200, headers });
				const identity = await deps.identity(request);
				phase = "route";
				const result = await runnerRoute(deps, request, identity);
				if (
					typeof result.body === "object" &&
					result.body !== null &&
					"ok" in result.body &&
					result.body.ok === false
				)
					return Response.json(
						{ error: "runner.action_refused" },
						{ status: 409, headers },
					);
				const body = JSON.stringify(result.body);
				if (new TextEncoder().encode(body).byteLength > 1_048_576)
					throw new Error("runner.response_too_large");
				return new Response(body, {
					status: result.status,
					headers: { ...headers, "content-type": "application/json" },
				});
			} catch (error) {
				const message =
					error instanceof RunnerAuthError
						? "runner.forbidden"
						: error instanceof Error
							? error.message
							: "";
				const status =
					error instanceof ZodError || error instanceof SyntaxError
						? 400
						: (statuses[message] ?? 503);
				if (status === 503)
					reportRunnerFailure(
						request,
						error,
						traceId,
						phase,
						deps.onDiagnostic,
					);
				return Response.json(
					{
						error:
							status === 400
								? "runner.invalid_request"
								: statuses[message]
									? message
									: "runner.unavailable",
					},
					{ status, headers },
				);
			}
		},
	};
}
