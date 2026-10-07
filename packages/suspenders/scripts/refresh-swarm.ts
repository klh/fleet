// Explicit code replacement for the kit serve runtime; no configuration sync.
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const files = [
	"swarm.ts",
	"serve-observation.ts",
	"observation.ts",
	"health.ts",
];
export async function refreshSwarm(
	runtime: string,
	root = join(import.meta.dir, "../.."),
	dryRun = false,
	validate: (file: string) => Promise<void> = async (file) => {
		const child = Bun.spawn(
			[process.execPath, "-e", "await import(process.argv[1])", file],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		const timeout = setTimeout(() => child.kill(), 10_000);
		try {
			if ((await child.exited) !== 0)
				throw new Error("swarm import validation failed");
		} finally {
			clearTimeout(timeout);
		}
	},
): Promise<void> {
	const originalSwarm = await readFile(join(runtime, "swarm.ts"), "utf8");
	if (originalSwarm.includes('from "./supervisor.ts"'))
		throw new Error(
			"advanced supervisor runtime: refusing conversion to kit serve",
		);
	if (
		!originalSwarm.includes('case "serve"') ||
		!originalSwarm.includes("serveOnce")
	)
		throw new Error("unsupported runtime: expected kit swarm serve");
	if (dryRun) {
		console.log(
			`Would replace kit runtime code: ${files.join(", ")}; preserve registry, tier, config and keys`,
		);
		return;
	}
	const lock = join(runtime, ".refresh-swarm.lock");
	await mkdir(lock); // fail closed while another code refresh owns the runtime
	let stage: string | undefined;
	const originals = new Map<string, string | null>();
	const changed: string[] = [];
	try {
		if ((await readFile(join(runtime, "swarm.ts"), "utf8")) !== originalSwarm)
			throw new Error("swarm.ts changed before refresh lock; retry");
		// A sibling stage preserves operator-owned ../belt module references.
		stage = await mkdtemp(join(dirname(runtime), ".fleet-swarm-code-"));
		// Import the flattened runtime's real code dependencies, without copying secrets.
		for (const entry of await readdir(runtime, { withFileTypes: true }))
			if (entry.isFile() && entry.name.endsWith(".ts"))
				await copyFile(join(runtime, entry.name), join(stage, entry.name));
		for (const file of files) {
			try {
				originals.set(file, await readFile(join(runtime, file), "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				originals.set(file, null);
			}
			await copyFile(join(root, "local-llm", file), join(stage, file));
		}
		await validate(join(stage, "swarm.ts"));
		for (const file of files) {
			const before = originals.get(file) ?? null;
			let current: string | null = null;
			try {
				current = await readFile(join(runtime, file), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (current !== before)
				throw new Error(`${file} changed during refresh; retry`);
			const after = await readFile(join(stage, file), "utf8");
			if (after === before) continue;
			if (before !== null)
				await writeFile(join(runtime, `${file}.serve-backup`), before, {
					mode: 0o600,
				});
			await writeFile(join(runtime, `${file}.serve-next`), after, {
				mode: 0o600,
			});
			await rename(join(runtime, `${file}.serve-next`), join(runtime, file));
			changed.push(file);
		}
	} catch (error) {
		for (const file of changed.reverse()) {
			const before = originals.get(file);
			if (before == null) await rm(join(runtime, file), { force: true });
			else await writeFile(join(runtime, file), before, { mode: 0o600 });
		}
		throw error;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
		await rm(lock, { recursive: true, force: true });
	}
	console.log(
		"Refreshed kit serve code; restart existing com.suspenders.local-llm to activate",
	);
}

if (import.meta.main)
	await refreshSwarm(
		`${process.env.HOME}/.claude/local-llm`,
		undefined,
		process.argv.includes("--dry-run"),
	);
