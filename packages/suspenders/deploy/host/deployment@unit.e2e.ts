import { chmodSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { runCliAsync, scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { validateDeployment } from "./deployment.ts";

test("deployment validates private owner paths, separate keys and actual socket group @unit", async () => {
	const world = scratchWorld();
	const home = realpathSync(world.home);
	const socket = createServer();
	try {
		const config = {
			networkMode: "host",
			hostname: "fleet-node-fixture",
			uid: process.getuid?.() ?? 1000,
			gid: process.getgid?.() ?? 1000,
			socketGid: process.getgid?.() ?? 1000,
			settings: join(home, "settings.json"),
			profiles: join(home, "profiles.json"),
			controlKey: join(home, "control.key"),
			mintKey: join(home, "mint.key"),
			readerKey: join(home, "reader.key"),
			state: join(home, "state"),
			seed: join(home, "seed"),
			socket: join(home, "docker.sock"),
		};
		for (const path of [config.state, config.seed])
			await mkdir(path, { mode: 0o700 });
		for (const path of [
			config.profiles,
			config.controlKey,
			config.mintKey,
			config.readerKey,
		])
			await writeFile(path, path.split("/").at(-1) ?? "fixture-only", {
				mode: 0o600,
			});
		const settings = {
			runner: {
				credential_file: config.controlKey,
				profiles_file: config.profiles,
				state_dir: config.state,
				desktop: {
					seed_root: config.seed,
					mint_credential_file: config.mintKey,
				},
			},
		};
		await writeFile(config.settings, JSON.stringify(settings), { mode: 0o600 });
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.listen(config.socket, resolve);
		});
		chmodSync(config.socket, 0o660);
		expect(validateDeployment(config)).toEqual(config);
		const deploymentFile = join(home, "deployment.json");
		await writeFile(deploymentFile, JSON.stringify(config), { mode: 0o600 });
		const cli = () =>
			runCliAsync(
				"--no-install",
				[join(import.meta.dir, "deployment.ts"), "--file", deploymentFile],
				{ env: { FORCE_COLOR: "0" } },
			);
		const valid = await cli();
		expect(valid.code).toBe(0);
		expect(valid.out.trim()).toBe('{"deployment":"validated"}');
		chmodSync(deploymentFile, 0o644);
		const refused = await cli();
		expect(refused.code).toBe(1);
		expect(refused.err.trim()).toBe("host.deployment_invalid");
		chmodSync(deploymentFile, 0o600);
		await writeFile(config.readerKey, "control.key");
		expect(() => validateDeployment(config)).toThrow("separate_credentials");
		await writeFile(config.readerKey, "reader.key");
		expect(() =>
			validateDeployment({ ...config, mintKey: config.controlKey }),
		).toThrow("separate_credentials");
		expect(() =>
			validateDeployment({ ...config, socketGid: config.socketGid + 1 }),
		).toThrow("socket_group_access");
		chmodSync(config.readerKey, 0o644);
		expect(() => validateDeployment(config)).toThrow("private_file");
		chmodSync(config.readerKey, 0o600);
		symlinkSync(config.state, join(home, "alias"));
		expect(() =>
			validateDeployment({ ...config, state: join(home, "alias") }),
		).toThrow("private_directory");
		await writeFile(
			config.settings,
			JSON.stringify({
				...settings,
				runner: { ...settings.runner, state_dir: "/container-only" },
			}),
		);
		expect(() => validateDeployment(config)).toThrow();
	} finally {
		try {
			if (socket.listening)
				await new Promise<void>((resolve, reject) =>
					socket.close((error) => (error ? reject(error) : resolve())),
				);
		} finally {
			world.clean();
		}
	}
});
