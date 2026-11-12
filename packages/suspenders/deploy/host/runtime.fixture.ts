import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configurationScript } from "./configuration.fixture.ts";
import { execFile } from "node:child_process";
import { HOST_BUILD_PINS } from "./contract.ts";

export function hostArgv(
	argv: string[],
	timeoutMs: number,
): Promise<{
	code: number;
	stdout: string;
	stderr: string;
	signal: string | null;
}> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !argv[0])
		throw new Error("Positive HOST process deadline required");
	return new Promise((resolve) => {
		execFile(
			argv[0],
			argv.slice(1),
			{
				encoding: "utf8",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 1048576,
			},
			(error, stdout, stderr) => {
				resolve({
					code: error
						? typeof error.code === "number"
							? error.code
							: error.killed
								? 124
								: 127
						: 0,
					stdout,
					stderr,
					signal: error?.signal ?? null,
				});
			},
		);
	});
}
async function checkedDocker(argv: string[], timeoutMs = 10000) {
	if (argv[0] !== "docker") throw new Error("Docker fixture argv required");
	const result = await hostArgv(
		["docker", "--context", "desktop-linux", ...argv.slice(1)],
		timeoutMs,
	);
	if (result.code !== 0)
		throw new Error(
			`Docker fixture command failed (${result.code}): ${result.stderr}`,
		);
	return result.stdout;
}
async function containerId(
	name: string,
	timeoutMs = 10000,
): Promise<string | undefined> {
	const result = await hostArgv(
		[
			"docker",
			"--context",
			"desktop-linux",
			"inspect",
			name,
			"--format",
			"{{.Id}}",
		],
		timeoutMs,
	);
	if (result.code === 0 && /^[a-f0-9]{64}$/.test(result.stdout.trim()))
		return result.stdout.trim();
	if (result.code === 1 && /No such (object|container)/i.test(result.stderr))
		return undefined;
	throw new Error(
		`HOST fixture inspection failed (${result.code}): ${result.stderr}`,
	);
}
async function removeOwned(name: string) {
	const cid = await containerId(name);
	if (cid) {
		await checkedDocker(["docker", "rm", "-f", cid]);
		if (await containerId(cid))
			throw new Error("Owned HOST fixture container survived removal");
	}
	return cid;
}
async function volumeInfo(name: string) {
	const result = await hostArgv(
		[
			"docker",
			"--context",
			"desktop-linux",
			"volume",
			"inspect",
			name,
			"--format",
			"{{json .}}",
		],
		10000,
	);
	if (result.code === 1 && /no such volume/i.test(result.stderr))
		return undefined;
	if (result.code !== 0)
		throw new Error(
			`Fixture volume inspection failed (${result.code}): ${result.stderr}`,
		);
	const VolumeSchema = z.object({
		Name: z.string(),
		Labels: z.record(z.string(), z.string()).nullable(),
	});
	return VolumeSchema.parse(JSON.parse(result.stdout));
}
export async function removeFixtureVolume(name: string) {
	const info = await volumeInfo(name);
	if (!info) return;
	if (info.Name !== name || info.Labels?.["io.klh.fleet.host-fixture"] !== name)
		throw new Error("Unowned fixture volume refusal");
	await checkedDocker(["docker", "volume", "rm", name], 10000);
	if (await volumeInfo(name))
		throw new Error("Owned fixture volume survived removal");
}

export async function openHostFixture(
	image: string,
	guest: string,
	profile: { seedDigest: string; policyDigest: string },
	authorityScript: string,
	waitForAuthority: (check: () => Promise<void>) => Promise<void>,
	id = `fleet-host-runtime-${randomUUID()}`,
) {
	if (!id.startsWith("fleet-host-runtime-"))
		throw new Error("Fixture namespace required");
	z.uuid().parse(id.slice("fleet-host-runtime-".length));
	const names: string[] = [];
	const cids = new Map<string, string>();
	const deadline = Date.now() + 80000;
	const remaining = (limit: number) => {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error("HOST fixture budget exhausted");
		return Math.min(limit, left);
	};
	const command = (argv: string[], timeoutMs = 10000) =>
		checkedDocker(argv, remaining(timeoutMs));
	let volumeAttempted = false;
	const clean = async () => {
		const removed = await Promise.allSettled(
			names.map(async (name) => {
				const cid = await removeOwned(cids.get(name) ?? name);
				if (cid) cids.set(name, cid);
			}),
		);
		const volume = await Promise.allSettled(
			volumeAttempted ? [removeFixtureVolume(id)] : [],
		);
		if ([...removed, ...volume].some((result) => result.status === "rejected"))
			throw new Error("Owned HOST runtime fixture cleanup failed");
	};
	const run = async (
		args: string[],
		name = `${id}-${names.length}`,
		timeoutMs = 10000,
	) => {
		names.push(name);
		const result = await command(
			["docker", "run", "--name", name, ...args],
			timeoutMs,
		);
		const cid = await containerId(name, remaining(10000));
		if (!cid) throw new Error("Owned fixture container identity missing");
		cids.set(name, cid);
		return result;
	};
	const client = (script: string) =>
		run(
			[
				"--network",
				"host",
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--entrypoint",
				"bun",
				HOST_BUILD_PINS.bun,
				"-e",
				script,
			],
			undefined,
			30000,
		);
	try {
		if (await volumeInfo(id))
			throw new Error("Fixture namespace already exists");
		volumeAttempted = true;
		await command([
			"docker",
			"volume",
			"create",
			"--label",
			`io.klh.fleet.host-fixture=${id}`,
			id,
		]);
		const root = (
			await command([
				"docker",
				"volume",
				"inspect",
				id,
				"--format",
				"{{.Mountpoint}}",
			])
		).trim();
		if (
			!root.startsWith("/var/lib/docker/volumes/") ||
			!root.endsWith("/_data")
		)
			throw new Error("Docker host volume path unavailable");

		const authority = `${id}-authority`;
		await run(
			[
				"-d",
				"--network",
				"host",
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop=ALL",
				"--entrypoint",
				"bun",
				HOST_BUILD_PINS.bun,
				"-e",
				authorityScript,
			],
			authority,
		);
		const PortsSchema = z.strictObject({
			port: z.number().int().min(1).max(65535),
			controlPort: z.number().int().min(1).max(65535),
		});
		let ports: z.infer<typeof PortsSchema> | undefined;
		await waitForAuthority(async () => {
			ports = PortsSchema.parse(
				JSON.parse((await command(["docker", "logs", authority])).trim()),
			);
		});
		if (!ports) throw new Error("Fixture ports unavailable");
		const identityUrl = `http://127.0.0.1:${ports.port}`,
			controlUrl = `http://127.0.0.1:${ports.controlPort}`;
		const setup = configurationScript({
			root,
			identityUrl,
			controlUrl,
			guest,
			profile,
		});
		const result = JSON.parse(
			await run([
				"--network",
				"none",
				"--user",
				"0:0",
				"--mount",
				`type=volume,source=${id},target=${root}`,
				"--mount",
				"type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
				"--entrypoint",
				"bun",
				HOST_BUILD_PINS.bun,
				"-e",
				setup,
			]),
		);
		const SocketSchema = z.strictObject({
			socketGid: z.number().int().nonnegative(),
		});
		const { socketGid } = SocketSchema.parse(result);
		const args = [
			"--network",
			"host",
			"--hostname",
			id,
			"--user",
			"1000:1000",
			"--group-add",
			String(socketGid),
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=64m",
			"--mount",
			`type=volume,source=${id},target=${root},readonly`,
			"--mount",
			`type=bind,source=${root}/state,target=${root}/state`,
			"--mount",
			"type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
			"--env",
			`KLH_SETTINGS=${root}/private/settings.json`,
		];
		const supervisor = (argv: string[], detached = false) =>
			run(
				[...(detached ? ["-d"] : []), ...args, image, ...argv],
				detached ? `${id}-supervisor` : undefined,
				detached ? 10000 : 30000,
			);
		const health = () =>
			run([
				"--network",
				"host",
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--mount",
				`type=bind,source=${root}/private/reader.key,target=/run/reader.key,readonly`,
				"--entrypoint",
				"bun",
				image,
				"/opt/fleet/health.js",
				"--target",
				controlUrl,
				"--key-file",
				"/run/reader.key",
			]);
		const trackGuest = (name: string) => names.push(name);
		const captureGuest = async (name: string) => {
			const cid = await containerId(name, remaining(10000));
			if (!cid) throw new Error("Guest identity missing");
			cids.set(name, cid);
			return cid;
		};
		return {
			image,
			id,
			root,
			identityUrl,
			controlUrl,
			supervisor,
			health,
			client,
			trackGuest,
			captureGuest,
			cids,
			command,
			clean,
		};
	} catch (error) {
		await clean();
		throw error;
	}
}
