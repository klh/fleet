import { expect } from "@playwright/test";
import { z } from "zod";
import { parsePolicy } from "../../src/policy.ts";
import { type fixture, FIXTURE_CAPABILITIES } from "./fixture.ts";
import { readHttp } from "./qualification-http.ts";

export const ModeSchema = z.enum(["main", "fallback", "neutral", "unkeyed"]);
export type QualificationMode = z.infer<typeof ModeSchema>;
const EffectivePolicySchema = z.object({
	num_retries: z.literal(0),
	request_timeout_s: z.literal(5),
	fallbacks: z.object({ "seed-model": z.tuple([z.literal("seed-fallback")]) }),
});
export async function configureFallback(
	data: Awaited<ReturnType<typeof fixture>>,
) {
	const FixtureUpstreamsSchema = z
		.object({
			groups: z.record(
				z.string(),
				z.array(
					z
						.object({
							capabilities: z.object({
								context_length: z.number(),
								max_output_tokens: z.number(),
								reasoning: z.boolean(),
								capability_source: z.literal("operator-pinned"),
							}),
						})
						.passthrough(),
				),
			),
		})
		.passthrough();
	const upstreams = FixtureUpstreamsSchema.parse(
		await Bun.file(`${data.site}/upstreams.json`).json(),
	);
	const selected = upstreams.groups["seed-model"]?.[0];
	if (!selected) throw Error("Missing selected fixture row");
	upstreams.groups["seed-fallback"] = [
		{
			...selected,
			model: "seed-fallback",
			group: "seed-fallback",
			capabilities: { ...FIXTURE_CAPABILITIES, max_output_tokens: 8192 },
		},
	];
	const FixturePolicySchema = z.object({
		gateway: z.object({
			num_retries: z.literal(0),
			request_timeout_s: z.literal(5),
			fallbacks: z.record(z.string(), z.array(z.string())).optional(),
		}),
		tags: z.record(z.string(), z.array(z.string())),
	});
	const policy = FixturePolicySchema.parse(
		await Bun.file(`${data.site}/policy.json`).json(),
	);
	policy.gateway.fallbacks = { "seed-model": ["seed-fallback"] };
	policy.tags["seed-fallback"] = ["locality:hub-local"];
	EffectivePolicySchema.parse(parsePolicy(JSON.stringify(policy)));
	await Bun.write(`${data.site}/upstreams.json`, JSON.stringify(upstreams));
	await Bun.write(`${data.site}/policy.json`, JSON.stringify(policy));
}
export async function qualifyNegative(
	origin: string,
	key: string,
	mode: Exclude<QualificationMode, "main">,
	count: () => number,
) {
	const headers = {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		before = count();
	const catalog = await readHttp(`${origin}/v1/models`, { headers });
	expect(catalog.status).toBe(mode === "unkeyed" ? 401 : 200);
	if (mode !== "unkeyed") {
		const body = z
			.object({ data: z.array(z.record(z.string(), z.unknown())) })
			.parse(JSON.parse(catalog.text));
		expect(body.data).toEqual(
			mode === "neutral"
				? []
				: [
						{ id: "seed-model", object: "model", owned_by: "buckle" },
						{
							id: "seed-fallback",
							object: "model",
							owned_by: "buckle",
							...FIXTURE_CAPABILITIES,
							max_output_tokens: 8192,
						},
					],
		);
	}
	if (mode !== "fallback")
		expect(
			(
				await readHttp(`${origin}/v1/chat/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						model: "seed-model",
						messages: [{ role: "user", content: "negative synthetic fixture" }],
					}),
				})
			).status,
		).toBe(mode === "neutral" ? 503 : 401);
	expect(count()).toBe(before);
	return {
		mode,
		catalogStatus: catalog.status,
		upstreamRequestDelta: 0,
		requestCounter:
			mode === "neutral" ? "all-upstream-requests" : "inference-requests-only",
		fallbackMismatchOmission: mode === "fallback",
	};
}
