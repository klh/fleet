import { expect } from "@playwright/test";
import { z } from "zod";
import { freePort, waitUp } from "@klh/test-kit";
import { fixture } from "./fixture.ts";
import { containerArgs, docker, removeOwnedContainer, safe } from "./docker.ts";

const NetworkFailureSchema = z.object({
	code: z.enum([
		"ECONNREFUSED",
		"ECONNRESET",
		"SocketClosed",
		"ConnectionRefused",
	]),
});
const RunningStateSchema = z.object({ Running: z.literal(true) });

/** Host-side fetch is intentional: container-loopback checks cannot prove NAT. */
export async function verifyPublishedHealth(
	image: string,
	platform: string,
	explicit: boolean,
) {
	const data = await fixture();
	let id = "";
	try {
		const port = await freePort();
		const boot = await docker([
			"run",
			"--detach",
			...containerArgs(data, platform, "runtime"),
			"--publish",
			`127.0.0.1:${port}:4201`,
			"--entrypoint",
			"bun",
			image,
			"/fleet/packages/suspenders/deploy/healthcheck/probe.ts",
			"--target",
			`http://host.docker.internal:${data.stub.port}/v1/models`,
			"--catalog-model",
			"seed-model",
			"--auth-env",
			"BUCKLE_ROOT_KEY",
			"--listen",
			"4201",
			"--every",
			"100",
			...(explicit ? ["--bind", "0.0.0.0"] : []),
		]);
		expect(boot.code, safe(boot.err, data)).toBe(0);
		id = boot.out.trim();
		const url = `http://127.0.0.1:${port}/healthz`;
		if (explicit) {
			await waitUp(url);
			const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true });
		} else {
			await expect
				.poll(
					async () =>
						(await docker(["logs", id])).out.includes(
							"healthcheck: sidecar on",
						),
					{ timeout: 10000 },
				)
				.toBe(true);
			let failure: unknown;
			try {
				const response = await fetch(url, {
					signal: AbortSignal.timeout(2000),
				});
				await response.body?.cancel();
			} catch (error) {
				failure = error;
			}
			const { code } = NetworkFailureSchema.parse(failure);
			const state = await docker([
				"inspect",
				id,
				"--format",
				"{{json .State}}",
			]);
			expect(state.code, safe(state.err, data)).toBe(0);
			RunningStateSchema.parse(JSON.parse(state.out));
			expect(
				data.stub.requests.some(
					(request) =>
						request.path === "/v1/models" &&
						request.auth === `Bearer ${data.rootKey}`,
				),
			).toBe(true);
			return {
				platform,
				image,
				bind: "default127.0.0.1",
				knownHealthyCatalogPolled: true,
				externalHealth: "unreachable",
				networkFailureCode: code,
				containerRunning: true,
				teardownChecked: true,
			};
		}
		expect(
			data.stub.requests.some(
				(request) =>
					request.path === "/v1/models" &&
					request.auth === `Bearer ${data.rootKey}`,
			),
		).toBe(true);
		return {
			platform,
			image,
			bind: explicit ? "0.0.0.0" : "default127.0.0.1",
			knownHealthyCatalogPolled: true,
			externalHealth: explicit ? 200 : "connection-refused",
			teardownChecked: true,
		};
	} finally {
		try {
			if (id) await removeOwnedContainer(id, data);
		} finally {
			try {
				data.stub.close();
			} finally {
				data.world.clean();
			}
		}
	}
}
