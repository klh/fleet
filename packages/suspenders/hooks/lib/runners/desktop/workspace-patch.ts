import { z } from "zod";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateWorkspaceArchive } from "./workspace-archive.ts";
import { WorkspaceCheckpointSchema } from "./workspace-checkpoint.ts";
import { IMAGE_PIN } from "./seed.ts";
import type { RunArgv, StreamRun } from "./spawn.ts";

export const PatchBaseSchema = z.strictObject({
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	archivePath: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const PatchRepositoryPathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(path) =>
			path === "." ||
			(!path.startsWith("/") &&
				!/[\\\0]/.test(path) &&
				path
					.split("/")
					.every(
						(part) =>
							part !== "" &&
							part !== "." &&
							part !== ".." &&
							part.toLowerCase() !== ".git",
					)),
		"patch: unsafe repository path",
	);
const ByteLimitSchema = z
	.number()
	.int()
	.positive()
	.max(1024 * 1024 * 1024);

/** Trusted HOST public base. Validation and later staging share one descriptor. */
export async function verifyPatchBase(input: unknown, maxBytes: number) {
	const base = PatchBaseSchema.parse(input),
		limit = ByteLimitSchema.parse(maxBytes);
	const file = await open(
		base.archivePath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			!process.getuid ||
			info.uid !== process.getuid() ||
			(info.mode & 0o777) !== 0o600 ||
			info.size > limit
		)
			throw new Error(
				"patch: base archive must be a private bounded regular file",
			);
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const event of validateWorkspaceArchive(
			file.createReadStream({ start: 0, autoClose: false }),
			{ maxEncodedBytes: limit, maxFileBytes: limit, maxEntries: 10_000 },
		)) {
			hash.update(event.bytes);
			bytes += event.bytes.length;
		}
		const sha256 = hash.digest("hex");
		if (sha256 !== base.sha256)
			throw new Error("patch: base archive integrity mismatch");
		return { file, bytes, sha256, commit: base.commit };
	} catch (error) {
		await file.close();
		throw error;
	}
}

export const WorkspacePatchInputSchema = z.strictObject({
	base: PatchBaseSchema,
	repositoryPath: PatchRepositoryPathSchema,
	maxBytes: ByteLimitSchema,
	checkpointRoot: z.string().min(1),
	checkpoint: WorkspaceCheckpointSchema,
	helperImage: z.string().regex(IMAGE_PIN),
	outputRoot: z.string().min(1),
	containerId: z.string().regex(/^[a-f0-9]{64}$/),
	operationDeadlineAt: z.number().int().positive(),
});
/** Execution identity comes from the owned handoff, never from the model. */
export const FinalWorkspacePatchRequestSchema = WorkspacePatchInputSchema.omit({
	checkpointRoot: true,
	checkpoint: true,
	containerId: true,
	operationDeadlineAt: true,
});
export type FinalWorkspacePatchRequest = z.output<
	typeof FinalWorkspacePatchRequestSchema
>;
export type FinalWorkspacePatch = Awaited<
	ReturnType<typeof exportWorkspacePatch>
>;

export interface WorkspacePatchDeps {
	assertOwned(): Promise<void>;
	dockerBin?: string;
	dockerArgv?(argv: string[]): string[];
	runDocker?: RunArgv;
	runDockerStream?(argv: string[]): Promise<StreamRun>;
}

const PatchGuestIdentitySchema = z.strictObject({
	id: z.string().regex(/^[a-f0-9]{64}$/),
	name: z.string(),
	image: z.string(),
	owner: z.string(),
	running: z.boolean(),
	oom: z.boolean(),
	network: z.string(),
	cpus: z.number(),
	memory: z.number(),
	pids: z.number(),
	readonlyRoot: z.boolean(),
	user: z.string(),
	capDrop: z.array(z.string()),
	security: z.array(z.string()),
});
type PatchOptions = z.output<typeof WorkspacePatchInputSchema>;
class PatchGuest {
	readonly owner = crypto.randomUUID();
	readonly name = `runner-patch-${this.owner}`;
	cid = "";
	attempted = false;
	ledgerPath = "";
	constructor(
		readonly opts: PatchOptions,
		readonly deps: WorkspacePatchDeps,
	) {}
	remaining() {
		const remaining =
			Math.min(
				this.opts.operationDeadlineAt,
				this.opts.checkpoint.binding.deadlineAt,
			) - Date.now();
		if (remaining <= 0) throw new Error("patch: original deadline expired");
		return Math.min(60_000, remaining);
	}
	async run(argv: string[], cleanup = false) {
		const { runArgv } = await import("./spawn.ts");
		if (!cleanup) await this.deps.assertOwned();
		const args = [this.deps.dockerBin ?? "docker", ...argv];
		const result = await (this.deps.runDocker ?? runArgv)(
			this.deps.dockerArgv ? this.deps.dockerArgv(args) : args,
			{ timeoutMs: cleanup ? 10_000 : this.remaining(), maxBytes: 65_536 },
		);
		if (result.code !== 0)
			throw new Error(`patch: Docker ${argv[0]} failed (${result.code})`);
		return result.stdout.trim();
	}
	async start(stage: string) {
		const { atomicWrite0600 } = await import(
			"@klh/kernel/src/kernel.atomic.module.ts"
		);
		const { join } = await import("node:path");
		const ledger = join(stage, "..", "helper.json");
		this.ledgerPath = ledger;
		const record = () =>
			`${JSON.stringify({ version: 1, owner: this.owner, name: this.name, image: this.opts.helperImage, containerId: this.cid || null })}\n`;
		atomicWrite0600(ledger, record());
		this.attempted = true;
		this.cid = await this.run([
			"create",
			"--name",
			this.name,
			"--label",
			`fleet.runner.patch=${this.owner}`,
			"--network",
			"none",
			"--read-only",
			"--user",
			"1000:1000",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--cpus",
			"2",
			"--memory",
			"1536m",
			"--pids-limit",
			"128",
			"--tmpfs",
			"/scratch:rw,nosuid,nodev,size=536870912,uid=1000,gid=1000,mode=0700",
			"--mount",
			`type=bind,src=${stage},dst=/input,readonly`,
			"--env",
			"HOME=/scratch/home",
			"--env",
			"GIT_CONFIG_NOSYSTEM=1",
			"--env",
			"GIT_CONFIG_GLOBAL=/dev/null",
			"--env",
			"GIT_ATTR_NOSYSTEM=1",
			"--entrypoint",
			"/usr/bin/sleep",
			this.opts.helperImage,
			"infinity",
		]);
		if (!/^[a-f0-9]{64}$/.test(this.cid)) {
			this.cid = "";
			throw new Error("patch: invalid created helper identity");
		}
		atomicWrite0600(ledger, record());
		await this.run(["start", this.cid]);
		const identity = await this.identity();
		if (
			!identity.running ||
			identity.oom ||
			identity.network !== "none" ||
			identity.cpus !== 2_000_000_000 ||
			identity.memory !== 1536 * 1024 * 1024 ||
			identity.pids !== 128 ||
			!identity.readonlyRoot ||
			identity.user !== "1000:1000" ||
			!identity.capDrop.includes("ALL") ||
			!identity.security.some(
				(value) =>
					value === "no-new-privileges" || value === "no-new-privileges=true",
			)
		)
			throw new Error("patch: helper isolation mismatch");
	}
	async remove() {
		const identity = await this.identity();
		this.cid = identity.id;
		const { atomicWrite0600 } = await import(
			"@klh/kernel/src/kernel.atomic.module.ts"
		);
		atomicWrite0600(
			this.ledgerPath,
			`${JSON.stringify({ version: 1, ...identity })}\n`,
		);
		await this.run(["rm", "--force", identity.id], true);
		if (
			await this.run(
				[
					"container",
					"ls",
					"--all",
					"--no-trunc",
					"--filter",
					`id=${identity.id}`,
					"--format",
					"{{.ID}}",
				],
				true,
			)
		)
			throw new Error("patch: helper removal not confirmed");
	}
	async step(argv: string[]) {
		return this.run(["exec", this.cid, ...argv]);
	}
	async identity() {
		const format =
			'{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"owner":{{json (index .Config.Labels "fleet.runner.patch")}},"running":{{json .State.Running}},"oom":{{json .State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"cpus":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}},"readonlyRoot":{{json .HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}}}';
		const value = PatchGuestIdentitySchema.parse(
			JSON.parse(
				await this.run(
					["inspect", "--format", format, this.cid || this.name],
					true,
				),
			),
		);
		if (
			(this.cid && value.id !== this.cid) ||
			value.name !== `/${this.name}` ||
			value.owner !== this.owner ||
			value.image !== this.opts.helperImage
		)
			throw new Error("patch: helper ownership mismatch");
		return value;
	}
}

async function collectPatch(
	guest: PatchGuest,
	argv: string[],
	destination: string,
) {
	const { runArgvStream } = await import("./spawn.ts");
	const args = [guest.deps.dockerBin ?? "docker", "exec", guest.cid, ...argv];
	await guest.deps.assertOwned();
	const output = await open(
		destination,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	const hash = createHash("sha256");
	let bytes = 0,
		timedOut = false;
	let child: StreamRun | undefined,
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		guest.remaining();
		child = await (guest.deps.runDockerStream ?? runArgvStream)(
			guest.deps.dockerArgv ? guest.deps.dockerArgv(args) : args,
		);
		const owned = child;
		timer = setTimeout(() => {
			timedOut = true;
			owned.kill();
		}, guest.remaining());
		for await (const chunk of child.stream) {
			bytes += chunk.length;
			if (bytes > guest.opts.maxBytes)
				throw new Error("patch: output byte limit");
			await output.writeFile(chunk);
			hash.update(chunk);
		}
		const code = await child.exit;
		await child.stderr();
		if (code !== 0 || timedOut) throw new Error("patch: binary diff failed");
		guest.remaining();
		await guest.deps.assertOwned();
		await output.sync();
		return { bytes, sha256: hash.digest("hex") };
	} finally {
		clearTimeout(timer);
		child?.kill();
		if (child) await Promise.allSettled([child.exit, child.stderr()]);
		await output.close();
	}
}

/** Copy from the already verified descriptor, rechecking bytes during staging. */
export async function stagePatchFile(
	file: Awaited<ReturnType<typeof open>>,
	destination: string,
	expectedSha256: string,
	limit: number,
) {
	const output = await open(
		destination,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const event of validateWorkspaceArchive(
			file.createReadStream({ start: 0, autoClose: false }),
			{ maxEncodedBytes: limit, maxFileBytes: limit, maxEntries: 10_000 },
		)) {
			await output.writeFile(event.bytes);
			hash.update(event.bytes);
			bytes += event.bytes.length;
		}
		if (hash.digest("hex") !== expectedSha256)
			throw new Error("patch: archive changed during staging");
		await output.sync();
		return bytes;
	} finally {
		await output.close();
	}
}

export async function exportWorkspacePatch(
	input: unknown,
	deps: WorkspacePatchDeps,
) {
	const opts = WorkspacePatchInputSchema.parse(input),
		guest = new PatchGuest(opts, deps);
	const { join } = await import("node:path"),
		{ rm } = await import("node:fs/promises");
	const { privateDirectory } = await import("../durable/private-paths.ts");
	await deps.assertOwned();
	guest.remaining();
	const directory = join(opts.outputRoot, crypto.randomUUID()),
		stage = join(directory, "input");
	await privateDirectory(opts.outputRoot);
	await privateDirectory(directory);
	await privateDirectory(stage);
	const patchPath = join(directory, "candidate.patch"),
		errors: unknown[] = [];
	let removed = false,
		cleanupAttempted = false,
		patch: { bytes: number; sha256: string } | undefined;
	try {
		await preparePatchInputs(opts, stage);
		await deps.assertOwned();
		guest.remaining();
		await guest.start(stage);
		const commands = patchGuestCommands(opts.repositoryPath);
		let baseTree = "";
		for (const argv of commands.slice(0, -1)) {
			const result = await guest.step(argv);
			if (argv.at(-1) === "write-tree") {
				if (!/^[a-f0-9]{40}$/.test(result))
					throw new Error("patch: invalid base tree");
				baseTree = result;
			}
		}
		const diff = commands.at(-1);
		if (!diff || !baseTree) throw new Error("patch: incomplete command plan");
		patch = await collectPatch(
			guest,
			diff.map((arg) => (arg === "__BASE_TREE__" ? baseTree : arg)),
			patchPath,
		);
		cleanupAttempted = true;
		await guest.remove();
		removed = true;
	} catch (error) {
		errors.push(error);
	} finally {
		if (guest.attempted && !cleanupAttempted) {
			cleanupAttempted = true;
			try {
				await guest.remove();
				removed = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (!guest.attempted || removed) {
			try {
				await rm(stage, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (errors.length || !patch)
		throw new AggregateError(
			errors,
			"patch: export failed; no receipt published",
		);
	guest.remaining();
	await deps.assertOwned();
	return publishPatchReceipt(
		opts,
		directory,
		patchPath,
		patch,
		{
			containerId: guest.cid,
			owner: guest.owner,
			removed: true,
		},
		deps.assertOwned,
	);
}

async function preparePatchInputs(opts: PatchOptions, stage: string) {
	const { openWorkspaceCheckpoint } = await import("./workspace-checkpoint.ts");
	const { chmod, writeFile } = await import("node:fs/promises"),
		{ join } = await import("node:path");
	const base = await verifyPatchBase(opts.base, opts.maxBytes);
	try {
		const captured = await openWorkspaceCheckpoint({
			root: opts.checkpointRoot,
			id: opts.checkpoint.id,
			expected: opts.checkpoint.binding,
			maxBytes: opts.maxBytes,
		});
		try {
			if (JSON.stringify(captured.manifest) !== JSON.stringify(opts.checkpoint))
				throw new Error("patch: checkpoint manifest mismatch");
			await stagePatchFile(
				base.file,
				join(stage, "base.tar"),
				opts.base.sha256,
				opts.maxBytes,
			);
			await stagePatchFile(
				captured.file,
				join(stage, "candidate.tar"),
				opts.checkpoint.archive.sha256,
				opts.maxBytes,
			);
		} finally {
			await captured.file.close();
		}
	} finally {
		await base.file.close();
	}
	// The private parent stays0700; only the read-only Docker bind is traversable by guest1000.
	await chmod(join(stage, "base.tar"), 0o644);
	await chmod(join(stage, "candidate.tar"), 0o644);
	await chmod(stage, 0o755);
	await writeFile(
		join(stage, "attributes"),
		"* -text -filter -ident -working-tree-encoding !diff\n",
		{ mode: 0o644, flag: "wx" },
	);
}

export const WorkspacePatchReceiptSchema = z.strictObject({
	version: z.literal(1),
	sourceBinding: z.literal("operator-supplied"),
	base: PatchBaseSchema.omit({ archivePath: true }),
	repositoryPath: PatchRepositoryPathSchema,
	checkpoint: WorkspaceCheckpointSchema,
	containerId: z.string().regex(/^[a-f0-9]{64}$/),
	helper: z.strictObject({
		containerId: z.string().regex(/^[a-f0-9]{64}$/),
		owner: z.uuid(),
		removed: z.literal(true),
	}),
	helperImage: z.string().regex(IMAGE_PIN),
	patch: z.strictObject({
		file: z.literal("candidate.patch"),
		bytes: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	}),
});
async function publishPatchReceipt(
	opts: PatchOptions,
	directory: string,
	patchPath: string,
	patch: { bytes: number; sha256: string },
	helper: { containerId: string; owner: string; removed: true },
	assertOwned: () => Promise<void>,
) {
	const { join } = await import("node:path");
	const { atomicWrite0600 } = await import(
		"@klh/kernel/src/kernel.atomic.module.ts"
	);
	const receipt = WorkspacePatchReceiptSchema.parse({
		version: 1,
		sourceBinding: "operator-supplied",
		base: { commit: opts.base.commit, sha256: opts.base.sha256 },
		repositoryPath: opts.repositoryPath,
		checkpoint: opts.checkpoint,
		containerId: opts.containerId,
		helperImage: opts.helperImage,
		helper,
		patch: { file: "candidate.patch", ...patch },
	});
	try {
		atomicWrite0600(
			join(directory, "receipt.json"),
			`${JSON.stringify(receipt)}\n`,
		);
		for (const path of [
			join(directory, "receipt.json"),
			directory,
			opts.outputRoot,
		]) {
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				await file.sync();
			} finally {
				await file.close();
			}
		}
		if (
			Math.min(opts.operationDeadlineAt, opts.checkpoint.binding.deadlineAt) <=
			Date.now()
		)
			throw new Error("patch: original deadline expired");
		await assertOwned();
	} catch (error) {
		const { rm } = await import("node:fs/promises");
		try {
			await rm(join(directory, "receipt.json"), { force: true });
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"patch: receipt rollback failed",
			);
		}
		throw error;
	}
	return { patchPath, sha256: patch.sha256, receipt };
}

/** __BASE_TREE__ is replaced only by validated write-tree output. */
export function patchGuestCommands(repositoryPath: string): string[][] {
	const root = PatchRepositoryPathSchema.parse(repositoryPath);
	const git = [
		"/usr/bin/git",
		"--no-replace-objects",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.attributesFile=/dev/null",
		"--git-dir=/scratch/trusted.git",
	];
	return [
		[
			"/usr/bin/mkdir",
			"-p",
			"/scratch/base",
			"/scratch/candidate",
			"/scratch/home",
		],
		[
			"/usr/bin/tar",
			"--extract",
			"--no-same-owner",
			"--no-same-permissions",
			"--exclude=.git",
			"--exclude=*/.git",
			"--file=/input/base.tar",
			"--directory=/scratch/base",
		],
		[...git, "init", "--bare", "/scratch/trusted.git"],
		[
			"/usr/bin/cp",
			"/input/attributes",
			"/scratch/trusted.git/info/attributes",
		],
		[
			...git,
			"--work-tree=/scratch/base",
			"-C",
			"/scratch/base",
			"add",
			"--all",
			"--force",
			"--",
			".",
		],
		[...git, "write-tree"],
		[
			"/usr/bin/tar",
			"--extract",
			"--no-same-owner",
			"--no-same-permissions",
			"--exclude=.git",
			"--exclude=*/.git",
			"--file=/input/candidate.tar",
			"--directory=/scratch/candidate",
		],
		[
			...git,
			`--work-tree=/scratch/candidate/${root}`,
			"-C",
			`/scratch/candidate/${root}`,
			"add",
			"--all",
			"--force",
			"--",
			".",
		],
		[
			...git,
			"diff",
			"--cached",
			"--binary",
			"--full-index",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"__BASE_TREE__",
			"--",
		],
	];
}
