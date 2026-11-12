import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const load = async () => import("./workspace-patch.ts");

async function exportFixture() {
	const world = scratchWorld(),
		archive = new Uint8Array(1024),
		basePath = join(world.home, "base.tar");
	const { saveWorkspaceCheckpoint } = await import("./workspace-checkpoint.ts");
	await writeFile(basePath, archive, { mode: 0o600 });
	const checkpoint = await saveWorkspaceCheckpoint({
		root: world.home,
		maxBytes: 4096,
		source: (async function* () {
			yield archive;
		})(),
		binding: {
			image: `fixture/tool@sha256:${"d".repeat(64)}`,
			deadlineAt: Date.now() + 60_000,
			leaseEpoch: 1,
			conversationId: "1",
			job: {
				runtime: "pi-durable@1.5.0",
				host: "fixture",
				spec: {
					version: 1,
					runId: crypto.randomUUID(),
					owner: "fixture",
					generation: 1,
					kind: "coding",
					provider: "fixture",
					model: "fixture",
					seedDigest: "a".repeat(64),
					policyDigest: "b".repeat(64),
				},
			},
		},
	});
	const opts = {
		checkpointRoot: world.home,
		checkpoint,
		base: {
			archivePath: basePath,
			sha256: sha(archive),
			commit: "a".repeat(40),
		},
		repositoryPath: "src",
		maxBytes: 4096,
		helperImage: checkpoint.binding.image,
		outputRoot: world.home,
		containerId: "c".repeat(64),
		operationDeadlineAt: Date.now() + 60_000,
	};
	const calls: string[][] = [],
		rewrites: string[][] = [],
		bytes = new Uint8Array([0xff, 0, 1, 10]);
	const faults = {
		diffCode: 0,
		remove: false,
		changedOwner: false,
		denied: false,
		overflow: false,
	};
	let owner = "",
		name = "";
	const rewrite = (argv: string[]) => {
		rewrites.push(argv);
		return ["selected-daemon", ...argv];
	};
	const deps = {
		assertOwned: async () => {
			if (faults.denied) throw new Error("captured authority lost");
		},
		dockerArgv: rewrite,
		runDocker: async (argv: string[]) => {
			const args = rewrite(argv).slice(2);
			calls.push(args);
			if (args[0] === "create") {
				owner = args[args.indexOf("--label") + 1]?.split("=")[1] ?? "";
				name = args[args.indexOf("--name") + 1] ?? "";
				return { code: 0, stdout: "e".repeat(64), stderr: "" };
			}
			if (args[0] === "inspect")
				return {
					code: 0,
					stdout: JSON.stringify({
						id: "e".repeat(64),
						name: `/${name}`,
						image: opts.helperImage,
						owner: faults.changedOwner ? "foreign" : owner,
						running: true,
						oom: false,
						network: "none",
						cpus: 2_000_000_000,
						memory: 1536 * 1024 * 1024,
						pids: 128,
						readonlyRoot: true,
						user: "1000:1000",
						capDrop: ["ALL"],
						security: ["no-new-privileges"],
					}),
					stderr: "",
				};
			return {
				code: args[0] === "rm" && faults.remove ? 7 : 0,
				stdout: args.at(-1) === "write-tree" ? "a".repeat(40) : "",
				stderr: "",
			};
		},
		runDockerStream: async (argv: string[]) => {
			calls.push(rewrite(argv).slice(2));
			return {
				stream: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(faults.overflow ? new Uint8Array(5000) : bytes);
						controller.close();
					},
				}),
				exit: Promise.resolve(faults.diffCode),
				kill() {},
				stderr: async () => "",
			};
		},
	};
	return { world, opts, deps, faults, calls, rewrites, bytes };
}

test("default raw runners route control and binary HOST subprocesses exactly once @unit", async () => {
	const f = await exportFixture();
	try {
		const shim = join(f.world.home, "docker-shim.ts"),
			state = join(f.world.home, "shim-state.json"),
			inputs: string[][] = [];
		const program =
			'const fs=require("node:fs");const [file,bin,...args]=process.argv.slice(2);if(bin!=="missing-fixture-docker")throw Error("addressing mismatch");const s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{seen:[]};s.seen.push(args);let out="";if(args[0]==="create"){s.owner=args[args.indexOf("--label")+1].split("=")[1];s.name=args[args.indexOf("--name")+1];s.image=args.at(-2);out="e".repeat(64)}if(args[0]==="inspect")out=JSON.stringify({id:"e".repeat(64),name:"/"+s.name,image:s.image,owner:s.owner,running:true,oom:false,network:"none",cpus:2000000000,memory:1610612736,pids:128,readonlyRoot:true,user:"1000:1000",capDrop:["ALL"],security:["no-new-privileges"]});if(args.at(-1)==="write-tree")out="a".repeat(40);if(args[0]==="rm")s.removed=true;fs.writeFileSync(file,JSON.stringify(s),{mode:384});if(args.includes("--binary"))await Bun.stdout.write(new Uint8Array([255,0,1,10]));else if(out)console.log(out);';
		await writeFile(shim, program, { mode: 0o600 });
		const { exportWorkspacePatch } = await load();
		const result = await exportWorkspacePatch(f.opts, {
			assertOwned: f.deps.assertOwned,
			dockerBin: "missing-fixture-docker",
			dockerArgv: (argv) => {
				inputs.push(argv);
				return [process.execPath, shim, state, ...argv];
			},
		});
		expect(result.sha256).toBe(sha(f.bytes));
		expect(inputs.length).toBeGreaterThan(10);
		expect(
			inputs.every(
				(argv) => argv[0] === "missing-fixture-docker" && !argv.includes(shim),
			),
		).toBe(true);
		expect(inputs.some((argv) => argv.includes("--binary"))).toBe(true);
		const { readFile } = await import("node:fs/promises");
		expect(JSON.parse(await readFile(state, "utf8")).removed).toBe(true);
	} finally {
		f.world.clean();
	}
});

test("injected complete runners route every control and binary command exactly once @unit", async () => {
	const f = await exportFixture();
	try {
		const { exportWorkspacePatch } = await load();
		await exportWorkspacePatch(f.opts, f.deps);
		expect(f.rewrites.length).toBeGreaterThan(10);
		expect(f.rewrites).toHaveLength(f.calls.length);
		expect(
			f.rewrites.every(
				(argv) => argv[0] === "docker" && !argv.includes("selected-daemon"),
			),
		).toBe(true);
		expect(f.rewrites.some((argv) => argv.includes("--binary"))).toBe(true);
	} finally {
		f.world.clean();
	}
});

test("isolated export persists exact raw patch bytes and bound receipt after helper removal @unit", async () => {
	const f = await exportFixture();
	try {
		const { exportWorkspacePatch } = await load(),
			{ readFile, stat } = await import("node:fs/promises");
		const result = await exportWorkspacePatch(f.opts, f.deps);
		expect(new Uint8Array(await readFile(result.patchPath))).toEqual(f.bytes);
		expect(result.sha256).toBe(sha(f.bytes));
		expect(result.receipt.sourceBinding).toBe("operator-supplied");
		expect(result.receipt.checkpoint).toEqual(f.opts.checkpoint);
		expect((await stat(result.patchPath)).mode & 0o777).toBe(0o600);
		expect(f.calls.some((args) => args[0] === "rm")).toBe(true);
		expect(f.calls.at(-1)?.slice(0, 2)).toEqual(["container", "ls"]);
		expect(f.rewrites.some((args) => args.includes("--binary"))).toBe(true);
	} finally {
		f.world.clean();
	}
});

for (const fault of [
	"diffCode",
	"overflow",
	"changedOwner",
	"remove",
] as const) {
	test(`export refuses ${fault} and never publishes a receipt @unit`, async () => {
		const f = await exportFixture();
		try {
			if (fault === "diffCode") f.faults.diffCode = 7;
			else f.faults[fault] = true;
			const { exportWorkspacePatch } = await load(),
				{ readdir } = await import("node:fs/promises");
			await expect(exportWorkspacePatch(f.opts, f.deps)).rejects.toThrow(
				"no receipt published",
			);
			expect(
				(await readdir(f.world.home, { recursive: true })).some((path) =>
					path.endsWith("receipt.json"),
				),
			).toBe(false);
			if (fault === "changedOwner")
				expect(f.calls.filter((args) => args[0] === "rm")).toHaveLength(0);
			if (fault === "remove")
				expect(f.calls.filter((args) => args[0] === "rm")).toHaveLength(1);
		} finally {
			f.world.clean();
		}
	});
}

test("lost captured authority refuses before any Docker operation @unit", async () => {
	const f = await exportFixture();
	try {
		f.faults.denied = true;
		const { exportWorkspacePatch } = await load();
		await expect(exportWorkspacePatch(f.opts, f.deps)).rejects.toThrow(
			"captured authority lost",
		);
		expect(f.calls).toEqual([]);
	} finally {
		f.world.clean();
	}
});

test("stalled diff exit is killed and joined within the original operation deadline @unit", async () => {
	const f = await exportFixture();
	try {
		f.opts.operationDeadlineAt = Date.now() + 350;
		let killed = false,
			joined = false;
		let finish: (code: number) => void = () => {};
		const exit = new Promise<number>((resolve) => {
			finish = resolve;
		}).then((code) => {
			joined = true;
			return code;
		});
		f.deps.runDockerStream = async () => ({
			stream: new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			}),
			exit,
			kill() {
				killed = true;
				finish(137);
			},
			stderr: async () => "",
		});
		const { exportWorkspacePatch } = await load(),
			start = Date.now();
		await expect(exportWorkspacePatch(f.opts, f.deps)).rejects.toThrow(
			"no receipt published",
		);
		expect(killed).toBe(true);
		expect(joined).toBe(true);
		expect(Date.now() - start).toBeLessThan(2000);
	} finally {
		f.world.clean();
	}
});

test("orchestration rejects corrupt base before Docker and publishes no patch @unit", async () => {
	const world = scratchWorld();
	try {
		const { saveWorkspaceCheckpoint } = await import(
			"./workspace-checkpoint.ts"
		);
		const basePath = join(world.home, "base.tar"),
			archive = new Uint8Array(1024);
		await writeFile(basePath, archive, { mode: 0o600 });
		const checkpoint = await saveWorkspaceCheckpoint({
			root: world.home,
			maxBytes: 4096,
			binding: {
				image: `fixture/tool@sha256:${"d".repeat(64)}`,
				deadlineAt: Date.now() + 60_000,
				leaseEpoch: 1,
				conversationId: "1",
				job: {
					runtime: "pi-durable@1.5.0",
					host: "fixture",
					spec: {
						version: 1,
						runId: crypto.randomUUID(),
						owner: "fixture",
						generation: 1,
						kind: "coding",
						provider: "fixture",
						model: "fixture",
						seedDigest: "a".repeat(64),
						policyDigest: "b".repeat(64),
					},
				},
			},
			source: (async function* () {
				yield archive;
			})(),
		});
		let calls = 0;
		const { exportWorkspacePatch } = await load();
		const failure = await exportWorkspacePatch(
			{
				checkpointRoot: world.home,
				checkpoint,
				base: {
					archivePath: basePath,
					sha256: "f".repeat(64),
					commit: "a".repeat(40),
				},
				repositoryPath: "src",
				maxBytes: 4096,
				helperImage: checkpoint.binding.image,
				outputRoot: world.home,
				containerId: "c".repeat(64),
				operationDeadlineAt: Date.now() + 60_000,
			},
			{
				assertOwned: async () => {},
				runDocker: async () => {
					calls++;
					return { code: 0, stdout: "", stderr: "" };
				},
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw failure;
		expect(failure.errors[0]?.message).toContain("base archive integrity");
		expect(calls).toBe(0);
	} finally {
		world.clean();
	}
});

test("patch commands force additions and isolate candidate Git metadata @unit", async () => {
	const { patchGuestCommands } = await load();
	const commands = patchGuestCommands("src");
	expect(
		commands.some((argv) => argv.includes("--force") && argv.includes("--all")),
	).toBe(true);
	expect(
		commands.some(
			(argv) =>
				argv.includes("--exclude=.git") && argv.includes("--exclude=*/.git"),
		),
	).toBe(true);
	expect(commands.flat()).not.toContain("HEAD");
	expect(commands.flat()).toContain("--git-dir=/scratch/trusted.git");
	expect(commands.flat()).toContain("--binary");
	expect(commands.flat()).toContain("--full-index");
});

for (const path of [
	"../outside",
	"/absolute",
	"src/.git",
	"src/../other",
	"src\0bad",
]) {
	test(`patch root refuses ${JSON.stringify(path)} @unit`, async () => {
		const { patchGuestCommands } = await load();
		expect(() => patchGuestCommands(path)).toThrow();
	});
}

test("authority lost during receipt persistence rolls back the published receipt @unit", async () => {
	const f = await exportFixture();
	try {
		let checksAfterRemoval = 0;
		f.deps.assertOwned = async () => {
			if (f.calls.at(-1)?.[0] === "container" && ++checksAfterRemoval === 2)
				throw new Error("late captured authority loss");
		};
		const { exportWorkspacePatch } = await load(),
			{ readdir } = await import("node:fs/promises");
		await expect(exportWorkspacePatch(f.opts, f.deps)).rejects.toThrow(
			"late captured authority loss",
		);
		expect(
			(await readdir(f.world.home, { recursive: true })).some((path) =>
				path.endsWith("receipt.json"),
			),
		).toBe(false);
	} finally {
		f.world.clean();
	}
});

test("in-place base mutation after verification refuses during same-FD staging @unit", async () => {
	const world = scratchWorld();
	try {
		const path = join(world.home, "base.tar"),
			original = new Uint8Array(1024);
		await writeFile(path, original, { mode: 0o600 });
		const { verifyPatchBase, stagePatchFile } = await load();
		const verified = await verifyPatchBase(
			{ archivePath: path, sha256: sha(original), commit: "a".repeat(40) },
			4096,
		);
		try {
			await writeFile(path, new Uint8Array(2048));
			await expect(
				stagePatchFile(
					verified.file,
					join(world.home, "copy.tar"),
					sha(original),
					4096,
				),
			).rejects.toThrow("archive changed during staging");
		} finally {
			await verified.file.close();
		}
	} finally {
		world.clean();
	}
});

test("final workspace export exposes a durable patch API rather than journal replay @unit", async () => {
	const implementation = await import("./workspace-patch.ts").catch(() => ({}));
	expect(implementation).toHaveProperty("exportWorkspacePatch");
});

test("FIFO base refuses promptly rather than blocking before fstat @unit", async () => {
	const world = scratchWorld();
	try {
		const { runArgv } = await import("./spawn.ts");
		const path = join(world.home, "base.fifo");
		expect(
			(
				await runArgv(["/usr/bin/mkfifo", "-m", "600", path], {
					timeoutMs: 1000,
				})
			).code,
		).toBe(0);
		const source = `import {verifyPatchBase} from ${JSON.stringify(import.meta.resolve("./workspace-patch.ts"))};try {await verifyPatchBase(${JSON.stringify({ archivePath: path, sha256: "a".repeat(64), commit: "b".repeat(40) })},4096);process.exit(0)}catch(e){console.error(e.message);process.exit(2)}`;
		const start = Date.now(),
			result = await runArgv([process.execPath, "--eval", source], {
				timeoutMs: 500,
			});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("private bounded regular file");
		expect(Date.now() - start).toBeLessThan(1500);
	} finally {
		world.clean();
	}
});

test("base archive mismatch refuses before guest effects @unit", async () => {
	const world = scratchWorld();
	try {
		const archive = new Uint8Array(1024),
			path = join(world.home, "base.tar");
		await writeFile(path, archive, { mode: 0o600 });
		const { verifyPatchBase } = await load();
		await expect(
			verifyPatchBase(
				{ archivePath: path, sha256: "f".repeat(64), commit: "a".repeat(40) },
				4096,
			),
		).rejects.toThrow("base archive integrity");
	} finally {
		world.clean();
	}
});

test("verified base bytes retain their immutable binding @unit", async () => {
	const world = scratchWorld();
	try {
		const archive = new Uint8Array(1024),
			path = join(world.home, "base.tar");
		await writeFile(path, archive, { mode: 0o600 });
		const { verifyPatchBase } = await load();
		const opened = await verifyPatchBase(
			{ archivePath: path, sha256: sha(archive), commit: "a".repeat(40) },
			4096,
		);
		try {
			expect(opened.bytes).toBe(1024);
			expect(opened.sha256).toBe(sha(archive));
		} finally {
			await opened.file.close();
		}
	} finally {
		world.clean();
	}
});
