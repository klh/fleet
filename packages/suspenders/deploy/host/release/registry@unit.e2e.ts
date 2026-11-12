import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { boundedCommand, registryClient } from "./registry.ts";
import { fixture } from "./test-fixture.ts";

test("registry reads raw content, requires digest and only exact MANIFEST_UNKNOWN means absent @unit", async () => {
	const f = fixture();
	const client = registryClient(
		async () => "fixture-token",
		async (_url, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer fixture-token",
			);
			return new Response(
				new Uint8Array(f.blobs.get(f.index.digest) ?? []).buffer,
				{
					headers: { "docker-content-digest": f.index.digest },
				},
			);
		},
	);
	expect(
		await client.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture"),
	).toBe(f.index.digest);
	const absent = registryClient(
		async () => "fixture-token",
		async () =>
			Response.json(
				{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
				{ status: 404 },
			),
	);
	expect(
		await absent.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture"),
	).toBeNull();
	for (const status of [401, 403, 429, 500])
		await expect(
			registryClient(
				async () => "fixture-token",
				async () => new Response("secret must not leak", { status }),
			).resolve("ghcr.io/klh/fleet/supervisor-seed:fixture"),
		).rejects.toThrow(`HTTP ${status}`);
});
test("registry refuses response cap, foreign references and changed digest @unit", async () => {
	const overflow = registryClient(
		async () => "token",
		async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
	);
	await expect(
		overflow.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture"),
	).rejects.toThrow("byte bound");
	await expect(
		overflow.resolve("ghcr.io/foreign/image:fixture"),
	).rejects.toThrow();
	const f = fixture();
	const changed = registryClient(
		async () => "token",
		async () =>
			new Response(new Uint8Array(f.blobs.get(f.index.digest) ?? []).buffer, {
				headers: { "docker-content-digest": `sha256:${"f".repeat(64)}` },
			}),
	);
	await expect(
		changed.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture"),
	).rejects.toThrow("digest");
});
test("trusted HOST command ignoring TERM is hard-killed/joined and output capped @unit", async () => {
	const world = scratchWorld();
	try {
		const before = performance.now();
		await expect(
			boundedCommand(
				[
					"bun",
					"-e",
					"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1500)",
				],
				world.home,
				100,
			),
		).rejects.toThrow("HOST command failed");
		expect(performance.now() - before).toBeLessThan(1000);
		await expect(
			boundedCommand(
				["bun", "-e", "process.stdout.write('x'.repeat(9*1024*1024))"],
				world.home,
				1000,
			),
		).rejects.toThrow("HOST command failed");
	} finally {
		world.clean();
	}
});

test("overflow rejects even when underlying reader cancellation never joins @unit", async () => {
	const client = registryClient(
		async () => "fixture-token",
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
					},
					cancel() {
						return new Promise(() => {});
					},
				}),
			),
	);
	const outcome = await Promise.race([
		client.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture").then(
			() => "success",
			() => "refused",
		),
		new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
	]);
	expect(outcome).toBe("refused");
});
test("explicit request deadline bounds a response body ignoring abort/cancel @unit", async () => {
	const client = registryClient(
		async () => "fixture-token",
		async () =>
			new Response(
				new ReadableStream({
					pull() {
						return new Promise(() => {});
					},
					cancel() {
						return new Promise(() => {});
					},
				}),
			),
		{ timeoutMs: 50 },
	);
	const outcome = await Promise.race([
		client.resolve("ghcr.io/klh/fleet/supervisor-seed:fixture").then(
			() => "success",
			() => "refused",
		),
		new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
	]);
	expect(outcome).toBe("refused");
});
test("HOST descendant holding inherited pipes cannot write after bounded refusal @unit", async () => {
	const world = scratchWorld();
	const marker = `${world.home}/after-return`;
	const descendant =
		"setTimeout(()=>Bun.write(" +
		JSON.stringify(marker) +
		", 'escaped'),300);setTimeout(()=>process.exit(0),1500)";
	const parent =
		"Bun.spawn([process.execPath,'-e'," +
		JSON.stringify(descendant) +
		"],{stdout:'inherit',stderr:'inherit'});setTimeout(()=>process.exit(0),10)";
	let outcome: string;
	try {
		const before = performance.now();
		outcome = await boundedCommand(["bun", "-e", parent], world.home, 100).then(
			() => "success",
			() => "refused",
		);
		expect(performance.now() - before).toBeLessThan(1000);
		// The old false-green path lets this concrete owned descendant write after return.
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(outcome).toBe("refused");
		expect(await Bun.file(marker).exists()).toBe(false);
	} finally {
		// The RED control self-terminates, so the failing witness never leaks a HOST process.
		await new Promise((resolve) => setTimeout(resolve, 1600));
		world.clean();
	}
});

test("actual-shape GHCR blob307 follows HTTPS CDN without forwarding bearer @unit", async () => {
	const f = fixture();
	const headersSeen: Array<{ host: string; authorization: string | null }> = [];
	const client = registryClient(
		async () => "fixture-bearer",
		async (url, init) => {
			const target = new URL(url);
			headersSeen.push({
				host: target.hostname,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			if (target.pathname.includes("/manifests/"))
				return Response.json(
					{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
					{ status: 404 },
				);
			if (target.hostname === "ghcr.io")
				return new Response(null, {
					status: 307,
					headers: {
						location:
							"https://pkg-containers.githubusercontent.com/ghcr1/blobs/fixture?signature=private-query",
						"docker-content-digest": f.config.digest,
					},
				});
			return new Response(
				new Uint8Array(f.blobs.get(f.config.digest) ?? []).buffer,
			);
		},
	);
	expect(await client.read(f.config.digest)).toEqual(
		f.blobs.get(f.config.digest),
	);
	expect(
		headersSeen
			.filter((row) => row.host === "ghcr.io")
			.every((row) => row.authorization === "Bearer fixture-bearer"),
	).toBe(true);
	expect(headersSeen.at(-1)).toEqual({
		host: "pkg-containers.githubusercontent.com",
		authorization: null,
	});
});
test("blob redirects refuse foreign origins/userinfo/nondefault port, loops and writes without leaking capability @unit", async () => {
	const f = fixture();
	for (const location of [
		"http://pkg-containers.githubusercontent.com/file",
		"https://foreign.example/file?signature=private-query",
		"https://user:password@pkg-containers.githubusercontent.com/file",
		"https://pkg-containers.githubusercontent.com:444/file",
	]) {
		let calls = 0;
		const client = registryClient(
			async () => "fixture-bearer",
			async (url) => {
				calls++;
				if (new URL(url).pathname.includes("/manifests/"))
					return Response.json(
						{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
						{ status: 404 },
					);
				return new Response(null, { status: 307, headers: { location } });
			},
		);
		const error = await client.read(f.config.digest).then(
			() => "",
			(error) => String(error),
		);
		expect(error).not.toBe("");
		expect(error).not.toContain("private-query");
		expect(calls).toBe(2);
	}
	const loop = registryClient(
		async () => "fixture-bearer",
		async (url) =>
			new URL(url).pathname.includes("/manifests/")
				? Response.json(
						{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
						{ status: 404 },
					)
				: new Response(null, {
						status: 307,
						headers: {
							location: "https://pkg-containers.githubusercontent.com/loop",
						},
					}),
	);
	await expect(loop.read(f.config.digest)).rejects.toThrow("redirect");
	let writes = 0;
	const writer = registryClient(
		async () => "fixture-bearer",
		async () => {
			writes++;
			return new Response(null, {
				status: 307,
				headers: {
					location: "https://pkg-containers.githubusercontent.com/write",
				},
			});
		},
	);
	await expect(
		writer.promote(
			"ghcr.io/klh/fleet/supervisor-seed:fixture",
			new Uint8Array(),
		),
	).rejects.toThrow();
	expect(writes).toBe(1);
});
test("redirect hops share one read deadline and never restore bearer on return to registry @unit", async () => {
	const f = fixture();
	let calls = 0;
	const client = registryClient(
		async () => "fixture-bearer",
		async (url, init) => {
			const target = new URL(url);
			calls++;
			if (target.pathname.includes("/manifests/"))
				return Response.json(
					{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
					{ status: 404 },
				);
			if (calls === 2)
				return new Response(null, {
					status: 307,
					headers: {
						location: "https://pkg-containers.githubusercontent.com/hop",
					},
				});
			if (calls === 3) {
				expect(new Headers(init?.headers).has("authorization")).toBe(false);
				return new Response(null, {
					status: 307,
					headers: {
						location:
							"https://ghcr.io/v2/klh/fleet/supervisor-seed/blobs/" +
							f.config.digest,
					},
				});
			}
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			return new Response(
				new ReadableStream({
					pull() {
						return new Promise(() => {});
					},
					cancel() {
						return new Promise(() => {});
					},
				}),
			);
		},
		{ timeoutMs: 50 },
	);
	await expect(client.read(f.config.digest)).rejects.toThrow("deadline");
});

test("CDN fetch/read failures redact signed redirect capabilities from diagnostics @unit", async () => {
	const f = fixture();
	for (const mode of ["fetch", "read"] as const) {
		const client = registryClient(
			async () => "fixture-bearer",
			async (url) => {
				const target = new URL(url);
				if (target.pathname.includes("/manifests/"))
					return Response.json(
						{ errors: [{ code: "MANIFEST_UNKNOWN" }] },
						{ status: 404 },
					);
				if (target.hostname === "ghcr.io")
					return new Response(null, {
						status: 307,
						headers: {
							location:
								"https://pkg-containers.githubusercontent.com/file?signature=private-query",
						},
					});
				if (mode === "fetch") throw Error(`network failure at ${url}`);
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error(`read failure at ${url}`));
						},
					}),
				);
			},
		);
		const error = await client.read(f.config.digest).then(
			() => "",
			(error) => String(error),
		);
		expect(error).not.toBe("");
		expect(error).not.toContain("private-query");
	}
});
