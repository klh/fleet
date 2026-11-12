import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configurationScript } from "./configuration.fixture.ts";
import { hostProcess } from "./process.ts";
import { HOST_BUILD_PINS } from "./contract.ts";

export async function hostArgv(argv: string[], timeoutMs: number) {
	const result = await hostProcess(argv, { timeoutMs, maxBytes: 1048576 });
	return {
		code: result.code ?? 1,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
		signal: result.signal,
	};
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
const ContainerInfoSchema = z.object({
	Id: z.string().regex(/^[a-f0-9]{64}$/),
	Name: z.string(),
	Config: z.object({
		Image: z.string(),
		Labels: z.record(z.string(), z.string()).nullable(),
	}),
	Mounts: z.array(
		z.object({
			Type: z.string(),
			Source: z.string(),
			Destination: z.string(),
			RW: z.boolean(),
		}),
	),
});
async function containerInfo(ref: string, timeoutMs = 10000) {
	const result = await hostArgv(
		[
			"docker",
			"--context",
			"desktop-linux",
			"inspect",
			ref,
			"--format",
			"{{json .}}",
		],
		timeoutMs,
	);
	if (result.code === 1 && /No such (object|container)/i.test(result.stderr))
		return undefined;
	if (result.code !== 0)
		throw new Error(
			`HOST fixture inspection failed (${result.code}): ${result.stderr}`,
		);
	return ContainerInfoSchema.parse(JSON.parse(result.stdout));
}
async function removeOwned(ref: string, owner: string, expectedCid?: string) {
	const info = await containerInfo(ref);
	if (!info) return;
	if (
		info.Config.Labels?.["io.klh.fleet.host-fixture"] !== owner ||
		(expectedCid !== undefined && info.Id !== expectedCid)
	)
		throw new Error("Unowned fixture container refusal");
	await checkedDocker(["docker", "rm", "-f", info.Id]);
	if (await containerInfo(info.Id))
		throw new Error("Owned HOST fixture container survived removal");
	return info.Id;
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
	const guests = new Map<string, string>();
	let cleanupGuest:
		| ((name: string, runId: string) => Promise<void>)
		| undefined;
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
		const joined = await Promise.allSettled(
			names
				.filter((name) => name.startsWith(`${id}-supervisor`))
				.map(async (name) => {
					const info = await containerInfo(cids.get(name) ?? name);
					if (!info) return;
					if (
						info.Config.Labels?.["io.klh.fleet.host-fixture"] !== id ||
						info.Id !== cids.get(name)
					)
						throw new Error("Unowned HOST producer refusal");
					await checkedDocker(
						["docker", "stop", "--time", "20", info.Id],
						25000,
					);
					const StateSchema = z.object({
						Running: z.literal(false),
						ExitCode: z.literal(0),
					});
					StateSchema.parse(
						JSON.parse(
							await checkedDocker([
								"docker",
								"inspect",
								info.Id,
								"--format",
								"{{json .State}}",
							]),
						),
					);
				}),
		);
		const guestResults = await Promise.allSettled(
			(joined.every((result) => result.status === "fulfilled")
				? [...guests]
				: []
			).map(async ([name, runId]) => {
				if (!cleanupGuest)
					throw new Error("Guest cleanup identity reader unavailable");
				await cleanupGuest(name, runId);
			}),
		);
		const removed = await Promise.allSettled(
			names.map(async (name) => {
				const cid = await removeOwned(
					cids.get(name) ?? name,
					id,
					cids.get(name),
				);
				if (cid) cids.set(name, cid);
			}),
		);
		const finalGuests = await Promise.allSettled(
			[...guests.keys()].map(async (name) => {
				if (await containerInfo(name))
					throw new Error("Guest survived HOST cleanup");
			}),
		);
		const volume = await Promise.allSettled(
			volumeAttempted &&
				[...joined, ...guestResults, ...removed, ...finalGuests].every(
					(result) => result.status === "fulfilled",
				)
				? [removeFixtureVolume(id)]
				: [],
		);
		if (
			[...joined, ...guestResults, ...removed, ...finalGuests, ...volume].some(
				(result) => result.status === "rejected",
			)
		)
			throw new Error("Owned HOST runtime fixture cleanup failed");
	};
	const run = async (
		args: string[],
		name = `${id}-${names.length}`,
		timeoutMs = 10000,
		cleanup = false,
	) => {
		names.push(name);
		const result = await (cleanup ? checkedDocker : command)(
			[
				"docker",
				"run",
				"--name",
				name,
				"--label",
				`io.klh.fleet.host-fixture=${id}`,
				...args,
			],
			timeoutMs,
		);
		const info = await containerInfo(name, cleanup ? 10000 : remaining(10000));
		if (!info || info.Config.Labels?.["io.klh.fleet.host-fixture"] !== id)
			throw new Error("Owned fixture container identity missing");
		cids.set(name, info.Id);
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
		let generation = 0;
		const supervisor = (argv: string[], detached = false) =>
			run(
				[...(detached ? ["-d"] : []), ...args, image, ...argv],
				detached ? `${id}-supervisor${generation++ || ""}` : undefined,
				detached ? 10000 : 30000,
			);
		const storage = (script: string, cleanup = false) =>
			run(
				[
					"--network",
					"none",
					"--user",
					"1000:1000",
					"--read-only",
					"--cap-drop=ALL",
					"--security-opt=no-new-privileges",
					"--mount",
					`type=volume,source=${id},target=${root}`,
					"--entrypoint",
					"bun",
					image,
					"-e",
					`const root=${JSON.stringify(root)};${script}`,
				],
				undefined,
				10000,
				cleanup,
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
		const trackGuest = (name: string, runId: string) => {
			z.uuid().parse(runId);
			if (name !== `fleet-runner-${runId.replaceAll("-", "").slice(0, 16)}`)
				throw new Error("Guest name binding required");
			guests.set(name, runId);
		};
		const guestIdentity = async (name: string, cleanup = false) => {
			const runId = guests.get(name);
			if (!runId) throw new Error("Unregistered guest refusal");
			const info = await containerInfo(
				name,
				cleanup ? 10000 : remaining(10000),
			);
			if (!info) return;
			const RecordSchema = z.object({
				runId: z.literal(runId),
				containerId: z.literal(info.Id),
				containerName: z.literal(name),
				image: z.literal(guest),
				seedDir: z.literal(`${root}/state/workspaces/${runId}/seed`),
			});
			const record = RecordSchema.parse(
				JSON.parse(
					await storage(
						`const fs=require('node:fs');
const fd=fs.openSync(root+'/state/workspaces/'+${JSON.stringify(runId)}+'/executor.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw Error('Guest record invalid');
const r=JSON.parse(fs.readFileSync(fd,'utf8'));console.log(JSON.stringify({runId:r.runId,containerId:r.containerId,containerName:r.containerName,image:r.image,seedDir:r.seedDir}))}finally{fs.closeSync(fd)}`,
						cleanup,
					),
				),
			);
			if (info.Name !== `/${name}` || info.Config.Image !== record.image)
				throw new Error("Guest container binding refusal");
			const binds = info.Mounts.filter((m) => m.Type === "bind");
			if (
				binds.length !== 1 ||
				binds[0]?.Source !== record.seedDir ||
				binds[0]?.Destination !== "/seed" ||
				binds[0]?.RW !== false
			)
				throw new Error("Guest seed binding refusal");
			return info.Id;
		};
		cleanupGuest = async (name) => {
			const cid = await guestIdentity(name, true);
			if (!cid) return;
			await checkedDocker(["docker", "rm", "-f", cid]);
			if (await containerInfo(cid))
				throw new Error("Owned guest survived removal");
			cids.set(name, cid);
		};
		const captureGuest = async (name: string) => {
			const cid = await guestIdentity(name);
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
			storage,
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
