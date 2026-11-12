import { z } from "zod";
import { readHttp } from "./qualification-http.ts";
export const UnkeyedControlsSchema = z
	.object({
		mode: z.literal("unkeyed"),
		catalogStatus: z.literal(401),
		completionStatus: z.literal(401),
		upstreamRequestDelta: z.literal(0),
		requestCounter: z.literal("all-upstream-requests"),
	})
	.strict();
export type DisposalIntent = {
	event: "unkeyed-forced-disposal-intent";
	at: string;
	containerId: string;
	runId: string;
	argv: readonly ["docker", "stop", "--time", "5", string];
	timeoutMs: 8000;
};
type Docker = (argv: readonly string[], timeoutMs?: number) => Promise<string>;
export async function qualifyUnkeyed(
	origin: string,
	count: () => number,
	observe: (fact: { method: string; path: string; status: number }) => void,
) {
	const before = count(),
		catalog = await readHttp(`${origin}/v1/models`);
	observe({ method: "GET", path: "/v1/models", status: catalog.status });
	if (catalog.status !== 401) throw Error("Unkeyed catalog did not refuse 401");
	const completion = await readHttp(`${origin}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "seed-model",
			messages: [{ role: "user", content: "unkeyed synthetic negative" }],
		}),
	});
	observe({
		method: "POST",
		path: "/v1/chat/completions",
		status: completion.status,
	});
	if (completion.status !== 401 || count() !== before)
		throw Error("Unkeyed completion/outbound controls refused");
	return UnkeyedControlsSchema.parse({
		mode: "unkeyed",
		catalogStatus: catalog.status,
		completionStatus: completion.status,
		upstreamRequestDelta: 0,
		requestCounter: "all-upstream-requests",
	});
}
export async function disposeUnkeyed(
	docker: Docker,
	input: unknown,
	emit: (intent: DisposalIntent) => void,
) {
	const InputSchema = z
			.object({
				id: z.string().regex(/^[a-f0-9]{64}$/),
				runId: z.uuid(),
				controls: UnkeyedControlsSchema,
			})
			.strict(),
		data = InputSchema.parse(input);
	const InspectSchema = z
		.array(
			z.object({
				Id: z.string(),
				Config: z.object({
					Image: z.literal(
						"ghcr.io/klh/fleet/buckle-seed@sha256:b57ec30f3582d298f4b465d3a8cd629ab3447b3b644dd26efde5a4cb0a062189",
					),
					Labels: z.record(z.string(), z.string()),
				}),
				State: z.object({
					Running: z.boolean(),
					ExitCode: z.number().int(),
					OOMKilled: z.boolean(),
				}),
			}),
		)
		.length(1);
	async function inspect() {
		const [record] = InspectSchema.parse(
			JSON.parse(await docker(["inspect", data.id])),
		);
		if (
			!record ||
			record.Id !== data.id ||
			record.Config.Labels["io.klh.seed.qualifier"] !== data.runId
		)
			throw Error("Unkeyed disposal ownership refused");
		return record;
	}
	const before = await inspect();
	if (
		!before.State.Running ||
		before.State.OOMKilled ||
		before.State.ExitCode !== 0
	)
		throw Error("Unkeyed producer was not alive before disposal intent");
	const intent: DisposalIntent = {
		event: "unkeyed-forced-disposal-intent",
		at: new Date().toISOString(),
		containerId: data.id,
		runId: data.runId,
		argv: ["docker", "stop", "--time", "5", data.id],
		timeoutMs: 8000,
	};
	emit(intent);
	await docker(intent.argv.slice(1), intent.timeoutMs);
	const after = await inspect();
	if (
		after.State.Running ||
		after.State.OOMKilled ||
		after.State.ExitCode !== 137
	)
		throw Error("Unkeyed post-intent forced disposal not proved");
	await docker(["rm", data.id]);
	if (
		await docker([
			"container",
			"ls",
			"--all",
			"--quiet",
			"--no-trunc",
			"--filter",
			`id=${data.id}`,
		])
	)
		throw Error("Unkeyed disposal absence not proved");
	return {
		graceful: false,
		expectedForcedDisposal: true,
		preintentRunningVerified: true,
		observedExitCode: 137,
		oomKilled: false,
		intent,
		removedAndAbsent: data.id,
	};
}
