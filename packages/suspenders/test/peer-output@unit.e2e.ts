import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateProviderConfig } from "@klh/settings/connections";
import { emitPeerFiles } from "@klh/belt/bin/connection-upstreams.ts";

test("peer CLI helper requires private credential output and keeps one captured credential snapshot", async () => {
	const world = scratchWorld();
	try {
		const profiles = validateProviderConfig({
			peer: {
				kind: "buckle",
				adapter: "buckle",
				endpoints: { openai: "https://peer-output.example/v1" },
				auth: { kind: "inline", key: "first-sentinel" },
				env: "PEER_KEY",
			},
		});
		let calls = 0;
		const fetcher = (async (_input, init) => {
			calls++;
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer first-sentinel",
			);
			if (profiles.peer) profiles.peer.key = "changed-sentinel";
			return Response.json({ data: [{ id: "observed-model" }] });
		}) as typeof fetch;
		await expect(
			emitPeerFiles(["peer"], {}, {}, undefined, undefined, profiles, fetcher),
		).rejects.toThrow("--env-out");
		expect(calls).toBe(0);
		const env = join(world.home, "peer.env"),
			out = join(world.home, "routes.json");
		await expect(
			emitPeerFiles(["peer"], {}, {}, env, env, profiles, fetcher),
		).rejects.toThrow("must differ");
		const text = await emitPeerFiles(
			["peer"],
			{},
			{},
			env,
			out,
			profiles,
			fetcher,
		);
		expect(calls).toBe(1);
		expect(readFileSync(env, "utf8")).toBe("PEER_KEY=first-sentinel\n");
		expect(statSync(env).mode & 0o777).toBe(0o600);
		expect(statSync(out).mode & 0o777).toBe(0o600);
		expect(text).not.toContain("sentinel");
		expect(readFileSync(out, "utf8")).toBe(text);
	} finally {
		world.clean();
	}
});
