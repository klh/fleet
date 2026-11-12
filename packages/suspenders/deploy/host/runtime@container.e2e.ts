import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	containerNameOf,
	resolvedPolicyDigest,
} from "../../hooks/lib/runners/desktop/docker-executor.ts";
import { DESKTOP_RUNNER_IMAGE } from "../../hooks/lib/runners/desktop/prereqs.ts";
import { canonicalSeedDigest } from "../../hooks/lib/runners/desktop/seed.ts";
import { authorityScript } from "./authority.fixture.ts";

import { hostArgv, openHostFixture } from "./runtime.fixture.ts";

const WireSchema = z.object({ status: z.number().int(), body: z.unknown() });
test("packaged HOST preflight, protected health, denied admission and actual sandbox tool @container", async () => {
	test.setTimeout(150000);
	const image = process.env.FLEET_SUPERVISOR_TEST_IMAGE;
	if (!image)
		throw new Error(
			"FLEET_SUPERVISOR_TEST_IMAGE must identify the built candidate",
		);
	const guest = DESKTOP_RUNNER_IMAGE;
	const host = await openHostFixture(
		image,
		guest,
		{
			seedDigest: canonicalSeedDigest([
				{ path: "marker", bytes: Buffer.from("HOST_FIXTURE_SEED_MARKER") },
			]),
			policyDigest: resolvedPolicyDigest({
				image: guest,
				seedRoot: "/fixture/seed",
				workspacesDir: "/fixture/workspaces",
			}),
		},
		authorityScript,
		(check) => expect(check).toPass({ timeout: 5000, intervals: [50] }),
	);
	const wire = async (
		url: string,
		method = "GET",
		body?: unknown,
		key = "fixture-owner",
	) =>
		WireSchema.parse(
			JSON.parse(
				await host.client(
					`const response=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{authorization:${JSON.stringify(`Bearer ${key}`)},"content-type":"application/json"},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}signal:AbortSignal.timeout(25000)});console.log(JSON.stringify({status:response.status,body:await response.json().catch(()=>null)}));`,
				),
			),
		);
	try {
		const receipt = JSON.parse(await host.supervisor(["--check"]));
		expect(receipt.preflight).toBe("passed");
		expect(receipt.modelCapabilities).toEqual([
			{
				id: "fixture",
				object: "model",
				owned_by: "fixture",
				context_length: 16384,
				max_output_tokens: 1024,
				reasoning: false,
				capability_source: "operator-pinned",
			},
		]);
		expect((await wire(`${host.identityUrl}/fixture-stats`)).body).toEqual({
			minted: 0,
			revoked: false,
			inference: 0,
			toolObserved: false,
		});
		await wire(`${host.identityUrl}/fixture-release-control`);
		await host.supervisor([], true);
		await expect(async () =>
			expect(
				(
					await wire(
						`${host.controlUrl}/v1/runner/runs`,
						"GET",
						undefined,
						"fixture-reader",
					)
				).status,
			).toBe(200),
		).toPass({ timeout: 10000, intervals: [100] });
		expect(JSON.parse(await host.health())).toEqual({
			check: "protected-runner-list",
			ok: true,
		});
		const runId = randomUUID();
		const name = containerNameOf(runId);
		host.trackGuest(name, runId);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs`,
					"POST",
					{ profile: "standard", runId },
					"invalid-fixture-key",
				)
			).status,
		).toBe(401);
		expect((await wire(`${host.identityUrl}/fixture-stats`)).body).toEqual({
			minted: 0,
			revoked: false,
			inference: 0,
			toolObserved: false,
		});
		expect(
			(
				await wire(`${host.controlUrl}/v1/runner/runs`, "POST", {
					profile: "standard",
					runId,
				})
			).status,
		).toBe(201);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${runId}/submit`,
					"POST",
					{
						requestId: randomUUID(),
						text: "Read the seed marker with the sandbox tool.",
					},
				)
			).status,
		).toBe(200);
		await expect(async () =>
			expect((await wire(`${host.identityUrl}/fixture-stats`)).body).toEqual({
				minted: 1,
				revoked: false,
				inference: 2,
				toolObserved: true,
			}),
		).toPass({ timeout: 20000, intervals: [100] });
		const guestCid = await host.captureGuest(name);
		const GuestBoundarySchema = z.object({
			Config: z.object({ Env: z.array(z.string()) }),
			HostConfig: z.object({
				NetworkMode: z.literal("none"),
				ReadonlyRootfs: z.literal(true),
				Tmpfs: z.record(z.string(), z.string()),
			}),
			Mounts: z.array(
				z.object({
					Type: z.enum(["bind", "tmpfs"]),
					Source: z.string().optional(),
					Destination: z.enum(["/seed", "/tmp", "/workspace"]),
					RW: z.boolean(),
				}),
			),
		});
		const boundary = GuestBoundarySchema.parse(
			JSON.parse(
				await host.command([
					"docker",
					"inspect",
					guestCid,
					"--format",
					"{{json .}}",
				]),
			),
		);
		expect(boundary.Mounts.filter((mount) => mount.Type === "bind")).toEqual([
			{
				Type: "bind",
				Source: `${host.root}/state/workspaces/${runId}/seed`,
				Destination: "/seed",
				RW: false,
			},
		]);
		for (const mount of boundary.Mounts.filter(
			(mount) => mount.Type === "tmpfs",
		)) {
			expect(["/tmp", "/workspace"]).toContain(mount.Destination);
			expect(mount.Source ?? "").toBe("");
			expect(mount.RW).toBe(true);
		}
		expect(Object.keys(boundary.HostConfig.Tmpfs).sort()).toEqual([
			"/tmp",
			"/workspace",
		]);
		for (const options of Object.values(boundary.HostConfig.Tmpfs)) {
			expect(options).toContain("noexec");
			expect(options).toContain("nosuid");
		}
		const environment = boundary.Config.Env.join("\n");
		expect(environment).not.toMatch(/fixture-(owner|reader|mint|model-key)/);
		for (const value of [host.identityUrl, host.controlUrl, host.root])
			expect(environment).not.toContain(value);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${runId}/abort`,
					"POST",
					{},
				)
			).body,
		).toEqual({ ok: true, state: "stopped" });
		expect((await wire(`${host.identityUrl}/fixture-stats`)).body).toEqual({
			minted: 1,
			revoked: true,
			inference: 2,
			toolObserved: true,
		});
		await expect(async () => {
			await expect(
				host.command(["docker", "inspect", guestCid]),
			).rejects.toThrow(/No such (object|container)/i);
		}).toPass({ timeout: 5000, intervals: [50] });
	} finally {
		await host.clean();
	}
});

test("failed HOST fixture setup removes its captured container and owned volume @container", async () => {
	test.setTimeout(150000);
	const image = process.env.FLEET_SUPERVISOR_TEST_IMAGE;
	if (!image)
		throw new Error(
			"FLEET_SUPERVISOR_TEST_IMAGE must identify the built candidate",
		);
	const id = `fleet-host-runtime-${randomUUID()}`;
	let failedCid = "";
	await expect(
		openHostFixture(
			image,
			DESKTOP_RUNNER_IMAGE,
			{
				seedDigest: canonicalSeedDigest([
					{ path: "marker", bytes: Buffer.from("HOST_FIXTURE_SEED_MARKER") },
				]),
				policyDigest: resolvedPolicyDigest({
					image: DESKTOP_RUNNER_IMAGE,
					seedRoot: "/fixture/seed",
					workspacesDir: "/fixture/workspaces",
				}),
			},
			"process.exit(99)",
			async (_check) => {
				const identity = await hostArgv(
					[
						"docker",
						"--context",
						"desktop-linux",
						"inspect",
						`${id}-authority`,
						"--format",
						"{{.Id}}",
					],
					10000,
				);
				expect(identity.code).toBe(0);
				failedCid = identity.stdout.trim();
				expect(failedCid).toMatch(/^[a-f0-9]{64}$/);
				await expect(async () => {
					const exited = await hostArgv(
						[
							"docker",
							"--context",
							"desktop-linux",
							"inspect",
							failedCid,
							"--format",
							"{{.State.ExitCode}}",
						],
						10000,
					);
					expect(exited.code).toBe(0);
					expect(exited.stdout.trim()).toBe("99");
				}).toPass({ timeout: 1000, intervals: [50] });
				throw new Error("fixture.intentional_setup_failure");
			},
			id,
		),
	).rejects.toThrow("fixture.intentional_setup_failure");
	expect(failedCid).toMatch(/^[a-f0-9]{64}$/);
	const removed = await hostArgv(
		["docker", "--context", "desktop-linux", "inspect", failedCid],
		10000,
	);
	expect(removed.code).toBe(1);
	expect(removed.stderr).toMatch(/No such (object|container)/i);
	const names = await hostArgv(
		[
			"docker",
			"--context",
			"desktop-linux",
			"ps",
			"-a",
			"--filter",
			`name=${id}`,
			"--format",
			"{{.ID}}",
		],
		10000,
	);
	expect(names.code).toBe(0);
	expect(names.stdout.trim()).toBe("");
	const volume = await hostArgv(
		["docker", "--context", "desktop-linux", "volume", "inspect", id],
		10000,
	);
	expect(volume.code).toBe(1);
	expect(volume.stderr).toMatch(/no such volume/i);
});
