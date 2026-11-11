import { expect } from "@playwright/test";
import { z } from "zod";
import type { fixture } from "./fixture.ts";
type Fixture = Awaited<ReturnType<typeof fixture>>;
import { containerArgs, docker, safe, removeOwnedContainer } from "./docker.ts";
const StateSchema = z.object({
	uid: z.literal(1000),
	arch: z.enum(["x64", "arm64"]),
	db: z.literal(true),
});
export async function verifyRuntime(
	data: Fixture,
	image: string,
	platform: string,
	id: string,
) {
	const probe = await docker([
		"run",
		"--rm",
		...containerArgs(data, platform, "runtime"),
		"--network",
		`container:${id}`,
		"--entrypoint",
		"bun",
		image,
		"/fleet/packages/suspenders/deploy/healthcheck/probe.ts",
		"--target",
		"http://127.0.0.1:4101/v1/models",
		"--catalog-model",
		"seed-model",
		"--auth-env",
		"BUCKLE_ROOT_KEY",
	]);
	expect(probe.code, safe(probe.err + probe.out, data)).toBe(0);
	const sidecar = await docker([
		"run",
		"--detach",
		...containerArgs(data, platform, "runtime"),
		"--network",
		`container:${id}`,
		"--entrypoint",
		"bun",
		image,
		"/fleet/packages/suspenders/deploy/healthcheck/probe.ts",
		"--target",
		"http://127.0.0.1:4101/v1/models",
		"--catalog-model",
		"seed-model",
		"--auth-env",
		"BUCKLE_ROOT_KEY",
		"--listen",
		"4201",
		"--every",
		"100",
	]);
	expect(sidecar.code, safe(sidecar.err, data)).toBe(0);
	try {
		const health = await docker([
			"exec",
			id,
			"bun",
			"-e",
			"for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:4201/healthz');if(r.status===200){console.log(r.status);process.exit(0)}}catch{}await Bun.sleep(100)}process.exit(1)",
		]);
		expect(health.code, safe(health.err, data)).toBe(0);
		expect(health.out.trim()).toBe("200");
	} finally {
		await removeOwnedContainer(sidecar.out.trim(), data);
	}
	const result = await docker([
		"exec",
		id,
		"bun",
		"-e",
		"console.log(JSON.stringify({uid:process.getuid(),arch:process.arch,db:await Bun.file('/data/buckle.db').exists()}))",
	]);
	expect(result.code, safe(result.err, data)).toBe(0);
	const state = StateSchema.parse(JSON.parse(result.out));
	expect(state.arch).toBe(platform === "linux/amd64" ? "x64" : "arm64");
	return { state, probeExitCode: probe.code };
}
const CatalogSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const UsageFrameSchema = z.object({
	usage: z.object({ total_tokens: z.literal(5) }),
});

export async function verifyApi(data: Fixture, origin: string) {
	const headers = {
		authorization: `Bearer ${data.rootKey}`,
		"content-type": "application/json",
	};
	const discovery = await fetch(`${origin}/v1/models`, { headers });
	expect(discovery.status).toBe(200);
	const ids = CatalogSchema.parse(await discovery.json()).data.map(
		(model) => model.id,
	);
	expect(ids).toEqual(["seed-model"]);
	const calls = () =>
		data.stub.requests.filter((request) =>
			request.path.endsWith("/chat/completions"),
		).length;
	const before = calls();
	const denied = await fetch(`${origin}/v1/chat/completions`, {
		method: "POST",
		headers: { ...headers, authorization: "Bearer invalid-fixture" },
		body: JSON.stringify({
			model: "seed-model",
			messages: [{ role: "user", content: "deny" }],
		}),
	});
	expect(denied.status).toBe(401);
	expect(calls()).toBe(before);
	const response = await fetch(`${origin}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "seed-model",
			stream: true,
			messages: [{ role: "user", content: "stream fixture" }],
		}),
	});
	expect(
		response.status,
		response.status === 200 ? undefined : safe(await response.text(), data),
	).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body?.getReader();
	if (!reader) throw Error("No response stream");
	const reads: string[] = [];
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		reads.push(new TextDecoder().decode(next.value));
	}
	expect(reads.length).toBeGreaterThan(1);
	const frames = reads
		.join("")
		.split("\n\n")
		.filter((frame) => frame.startsWith("data: "))
		.map((frame) => frame.slice(6).trim());
	expect(frames.at(-1)).toBe("[DONE]");
	UsageFrameSchema.parse(JSON.parse(frames.at(-2) ?? "null"));
	return {
		ids,
		deniedStatus: denied.status,
		deniedUpstreamCalls: 0,
		streamReads: reads.length,
		terminalUsage: true,
	};
}
export async function verifyNeutral(
	data: Fixture,
	image: string,
	platform: string,
) {
	const { start } = await import("./docker.ts");
	const service = await start(data, image, platform, "neutral");
	try {
		const headers = {
			authorization: `Bearer ${data.rootKey}`,
			"content-type": "application/json",
		};
		const catalog = await fetch(`${service.origin}/v1/models`, { headers });
		expect(catalog.status).toBe(200);
		expect(CatalogSchema.parse(await catalog.json()).data).toEqual([]);
		const before = data.stub.requests.length;
		const response = await fetch(`${service.origin}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "seed-model",
				messages: [{ role: "user", content: "no route" }],
			}),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(data.stub.requests.length).toBe(before);
		return {
			advertisedModels: [],
			completionStatus: response.status,
			upstreamCalls: 0,
		};
	} finally {
		await removeOwnedContainer(service.id, data);
	}
}
export async function verifyUnkeyed(
	data: Fixture,
	image: string,
	platform: string,
) {
	const { start } = await import("./docker.ts");
	const service = await start(data, image, platform, "unauthenticated");
	try {
		const before = data.stub.requests.filter(
			(request) => request.path === "/v1/chat/completions",
		).length;
		const response = await fetch(`${service.origin}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "seed-model",
				messages: [{ role: "user", content: "no credential" }],
			}),
		});
		expect(response.status).toBe(401);
		expect(
			data.stub.requests.filter(
				(request) => request.path === "/v1/chat/completions",
			).length,
		).toBe(before);
		return { status: response.status, inferenceCalls: 0 };
	} finally {
		await removeOwnedContainer(service.id, data);
	}
}
