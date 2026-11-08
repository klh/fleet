import { expandHome, RunnerServiceUrlSchema, settings } from "@klh/settings";
import { readRunnerCredential } from "./credential.ts";
import { readWireJson } from "./wire.ts";

export function createRunnerClient(options: {
	url?: string;
	keyFile?: string;
}) {
	const config =
		options.url && options.keyFile
			? undefined
			: settings({ mode: "service" }).runner;
	const base = RunnerServiceUrlSchema.parse(options.url ?? config?.control_url);
	const path = options.keyFile ?? config?.credential_file;
	if (!path) throw new Error("runner.private_credential_required");
	const key = readRunnerCredential(expandHome(path));
	return async (path: string, body?: unknown): Promise<unknown> => {
		try {
			const response = await fetch(new URL(`/v1/runner${path}`, base), {
				method: body === undefined ? "GET" : "POST",
				redirect: "error",
				headers: {
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
				},
				signal: AbortSignal.timeout(15_000),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new Error(`runner.http_${response.status}`);
			}
			return await readWireJson(response, 1_048_576);
		} catch (error) {
			if (error instanceof Error && /^runner\.http_\d{3}$/.test(error.message))
				throw error;
			throw new Error("runner.request_failed");
		}
	};
}
