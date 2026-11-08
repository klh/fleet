import { z } from "zod";
import { createRunnerApi } from "./api.ts";
import type { RunnerApiDependencies } from "./types.ts";

const ListenerSchema = z.object({
	port: z.number().int().min(0).max(65_535),
	hostname: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
});

/** The control listener stays loopback; a trusted proxy may expose TLS separately. */
export function openRunnerListener(
	deps: RunnerApiDependencies & {
		port: number;
		hostname?: "127.0.0.1" | "::1";
	},
) {
	const listen = ListenerSchema.parse(deps);
	let api: ReturnType<typeof createRunnerApi> | undefined;
	const server = Bun.serve({
		...listen,
		development: false,
		maxRequestBodySize: 65_536,
		idleTimeout: 30,
		fetch(request) {
			return api
				? api.fetch(request)
				: Response.json({ error: "runner.starting" }, { status: 503 });
		},
	});
	api = createRunnerApi({
		...deps,
		allowedHosts: [server.url.host, ...(deps.allowedHosts ?? [])],
	});
	return {
		url: server.url,
		async stop(closeActiveConnections = true) {
			await server.stop(closeActiveConnections);
		},
	};
}
