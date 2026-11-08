import type { Parsed } from "../../verb-kit.ts";
import { RunIdSchema, SinceSchema } from "./contracts.ts";
import { createRunnerClient } from "./client.ts";
import { runnerOutput } from "./output.ts";

export async function runRunnerCommand(operation: string, parsed: Parsed) {
	const ndjson = parsed.rest.includes("--ndjson");
	try {
		const client = createRunnerClient({
			url: parsed.flag("--url") ?? undefined,
			keyFile: parsed.flag("--key-file") ?? undefined,
		});
		let path = "/runs";
		let body: unknown;
		if (operation === "admit")
			body = {
				runId: RunIdSchema.parse(
					parsed.flag("--run-id") ?? crypto.randomUUID(),
				),
				profile: parsed.flag("--profile"),
			};
		else if (operation === "list") {
			const after = parsed.flag("--after");
			if (after) path += `?after=${RunIdSchema.parse(after)}`;
		} else {
			path += `/${RunIdSchema.parse(parsed.pos[0])}`;
			if (operation === "read") {
				const since = parsed.flag("--since");
				if (since !== null) path += `?since=${SinceSchema.parse(since)}`;
			} else {
				path += `/${operation}`;
				body =
					operation === "submit"
						? {
								text: parsed.flag("--text"),
								requestId: parsed.flag("--request-id"),
							}
						: ["attach", "replay", "detach"].includes(operation)
							? { readerId: parsed.flag("--reader") }
							: {};
			}
		}
		runnerOutput(
			operation,
			await client(path, body),
			ndjson,
			parsed.rest.includes("--json"),
		);
		return 0;
	} catch (error) {
		const code =
			error instanceof Error && /^runner\.[a-z_0-9]+$/.test(error.message)
				? error.message
				: "runner.invalid_request";
		console.error(`coord runner: ${code}`);
		if (ndjson)
			console.log(
				JSON.stringify({
					version: 1,
					type: "complete",
					operation,
					ok: false,
					error: code,
				}),
			);
		return 1;
	}
}
