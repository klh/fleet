import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	requestedEffort,
	servedIdentity,
	stampServedIdentity,
} from "../src/served-identity.ts";

test("wire adapter never invents provider and only a configured peer can supply identity", () => {
	const headers = new Headers({
		"x-klh-served-model": "peer-model",
		"x-klh-served-provider": "peer-provider",
	});
	const dep = {
		group: "task",
		url: "https://fixture.invalid",
		dialect: "anthropic" as const,
		model: "configured-model",
	};
	expect(servedIdentity(dep, headers)).toMatchObject({
		model: "configured-model",
		provider: null,
		evidence: "configured",
	});
	expect(servedIdentity({ ...dep, buckle: true }, headers)).toMatchObject({
		model: "peer-model",
		provider: "peer-provider",
		evidence: "peer",
	});
	expect(
		servedIdentity(
			{ ...dep, provider: "zai", providerProfile: "coding" },
			new Headers(),
		),
	).toMatchObject({ provider: "zai", providerProfile: "coding" });
	stampServedIdentity(headers, {
		model: null,
		provider: null,
		providerProfile: null,
		evidence: "unknown",
	});
	expect(headers.has("x-klh-served-provider")).toBe(false);
});

test("effort is allowlisted with the alternate wire field preserved", () => {
	expect(requestedEffort({ output_config: {}, reasoning_effort: "high" })).toBe(
		"high",
	);
	expect(
		requestedEffort({
			output_config: { effort: "low" },
			reasoning_effort: "high",
		}),
	).toBe("low");
	expect(requestedEffort({ reasoning_effort: "unbounded-label" })).toBeNull();
});

test("actual upstream loader validates canonical non-secret provider IDs", () => {
	const dir = mkdtempSync(join(tmpdir(), "served-provider-"));
	const path = join(dir, "upstreams.json");
	try {
		const load = (provider: unknown) => {
			writeFileSync(
				path,
				JSON.stringify({
					groups: {
						task: [
							{
								url: "https://fixture.invalid",
								dialect: "openai",
								provider,
								providerProfile: "coding-account",
							},
						],
					},
				}),
			);
			return Bun.spawnSync(
				[
					process.execPath,
					"-e",
					`import {loadUpstreams} from ${JSON.stringify(new URL("../src/upstreams.ts", import.meta.url).pathname)};const d=loadUpstreams(process.argv[1]).deployments('task')[0];console.log(d.provider,d.providerProfile)`,
					path,
				],
				{
					env: { ...process.env, BUCKLE_UPSTREAMS: "" },
					stderr: "pipe",
					stdout: "pipe",
				},
			);
		};
		const valid = load("zai");
		expect(valid.exitCode).toBe(0);
		expect(valid.stdout.toString()).toContain("zai coding-account");
		for (const invalid of ["", "arbitrary label", 7]) {
			const result = load(invalid);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).toContain("provider");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
