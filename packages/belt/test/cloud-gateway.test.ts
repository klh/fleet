import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudGateway } from "../bin/cloud-gateway.ts";
import { DEFAULT_PATHS, litellmTarget } from "../bin/litellm-target.ts";

test("gateway owns only its LiteLLM factory child and propagates child exit", async () => {
	const root = mkdtempSync(join(tmpdir(), "cloud-only-"));
	try {
		const target = litellmTarget({
			paths: { ...DEFAULT_PATHS, log: join(root, "child.log") },
			env: { Z_AI_API_KEY: "fixture-zai", LITELLM_KEY: "fixture-master" },
			preflight: () => null,
			argv: [process.execPath, "-e", "process.exit(7)"],
		});
		expect(await runCloudGateway(target)).toBe(7);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("shutdown signals reach the owned child and handlers are removed", async () => {
	const signals = new EventEmitter();
	const kills: string[] = [];
	let exit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		exit = resolve;
	});
	const target = {
		...litellmTarget(),
		preflight: () => null,
		spawn: () => ({
			pid: 0,
			exited,
			kill: (signal?: number | NodeJS.Signals) => {
				kills.push(String(signal));
				exit(143);
			},
		}),
	};
	const done = runCloudGateway(
		target,
		signals as unknown as Pick<NodeJS.Process, "on" | "off">,
	);
	signals.emit("SIGTERM");
	expect(await done).toBe(0);
	expect(kills).toEqual(["SIGTERM"]);
	expect(signals.listenerCount("SIGTERM")).toBe(0);
	expect(signals.listenerCount("SIGINT")).toBe(0);
});
test("failed preflight never starts any child", async () => {
	let spawned = false;
	const target = {
		...litellmTarget(),
		preflight: () => "dependency missing",
		spawn: () => {
			spawned = true;
			throw new Error("must not spawn");
		},
	};
	await expect(runCloudGateway(target)).rejects.toThrow("dependency missing");
	expect(spawned).toBe(false);
});
