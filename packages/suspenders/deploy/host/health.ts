import { isIP } from "node:net";
import { z } from "zod";
import { createMonitor } from "../healthcheck/probe.ts";
import { readRunnerCredential } from "../../hooks/lib/runners/api/credential.ts";
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
} from "../../hooks/lib/verb-kit.ts";

const HealthOptionsSchema = z.strictObject({
	target: z.url().refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			url.hostname === "127.0.0.1" &&
			!!url.port &&
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash
		);
	}),
	keyFile: z.string().startsWith("/"),
	listen: z.coerce.number().int().min(1).max(65535).optional(),
	bind: z
		.string()
		.refine((value) => isIP(value) !== 0)
		.default("127.0.0.1"),
});

/** Separate process only. Captures a private READ credential without adding an
 * operator environment setting; the shared monitor owns miss/re-probe policy. */
export function runnerHealth(raw: unknown) {
	const options = HealthOptionsSchema.parse(raw);
	const key = readRunnerCredential(options.keyFile);
	return {
		options,
		monitor: createMonitor(
			{
				target: new URL("/v1/runner/runs", options.target).href,
				every: 5000,
				timeout: 2000,
				misses: 3,
				ring: 20,
			},
			{ headers: { authorization: `Bearer ${key}` }, expect: "runs" },
		),
	};
}

const spec = defineVerb({
	name: "check",
	usage:
		"health.ts [--listen PORT] [--bind IP] --target http://127.0.0.1:PORT --key-file /private/reader.key",
	flags: ["--target", "--key-file", "--listen", "--bind"],
	reqFlags: ["--target", "--key-file"],
});

if (import.meta.main) {
	const parsed = parseVerb(spec, process.argv.slice(2));
	if (!parsed.ok) {
		console.error(renderVerbHelp(spec));
		process.exit(2);
	}
	try {
		const { monitor, options } = runnerHealth({
			target: parsed.parsed.flag("--target"),
			keyFile: parsed.parsed.flag("--key-file"),
			listen: parsed.parsed.flag("--listen") ?? undefined,
			bind: parsed.parsed.flag("--bind") ?? undefined,
		});
		await monitor.poll();
		if (options.listen === undefined) {
			console.log(
				JSON.stringify({
					check: "protected-runner-list",
					ok: monitor.snapshot().ok,
				}),
			);
			process.exit(monitor.snapshot().ok ? 0 : 1);
		}
		setInterval(() => {
			void monitor.poll();
		}, 5000);
		Bun.serve({
			port: options.listen,
			hostname: options.bind,
			fetch: (request) => {
				if (new URL(request.url).pathname !== "/healthz")
					return new Response(null, { status: 404 });
				if (request.method !== "GET" && request.method !== "HEAD")
					return new Response(null, { status: 405 });
				const snapshot = monitor.snapshot();
				return Response.json(
					{
						check: "protected-runner-list",
						ok: snapshot.ok,
						state: snapshot.state,
					},
					{
						status: snapshot.ok ? 200 : 502,
						headers: { "cache-control": "no-store" },
					},
				);
			},
		});
	} catch {
		console.error("runner.health_failed");
		process.exit(1);
	}
}
