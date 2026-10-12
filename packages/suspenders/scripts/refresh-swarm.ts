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
import { spawnSync } from "node:child_process";

export interface ActivationReadiness {
	state: "active" | "drained" | "unknown";
	connections: number | null;
	reason: string;
}
interface ConnectionInspection {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: unknown;
}

/** Conservative transport activity, not proof that inference is in flight. */
export function inspectGatewayConnections(
	inspect: () => ConnectionInspection = () =>
		spawnSync(
			"/usr/sbin/lsof",
			["-nP", "-a", "-iTCP:4000,4100,4101", "-sTCP:ESTABLISHED", "-Ff"],
			{ encoding: "utf8", timeout: 2000, maxBuffer: 128 * 1024 },
		),
): ActivationReadiness {
	let result: ConnectionInspection;
	try {
		result = inspect();
	} catch {
		return {
			state: "unknown",
			connections: null,
			reason: "connection inspection unavailable",
		};
	}
	if (
		result.error ||
		result.stderr.trim() ||
		![0, 1].includes(result.status ?? -1)
	)
		return {
			state: "unknown",
			connections: null,
			reason: "connection inspection failed or incomplete",
		};
	if (result.status === 1 && !result.stdout.trim())
		return {
			state: "drained",
			connections: 0,
			reason: "no established gateway connections observed",
		};
	const rows = result.stdout.trim().split("\n");
	if (
		result.status !== 0 ||
		rows.some((row) => !/^[pf]\d+$/.test(row)) ||
		!rows.some((row) => row.startsWith("f"))
	)
		return {
			state: "unknown",
			connections: null,
			reason: "unrecognized connection evidence",
		};
	const connections = rows.filter((row) => row.startsWith("f")).length;
	return {
		state: "active",
		connections,
		reason: "established downstream gateway connections observed",
	};
}

export function activationGuidance(readiness: ActivationReadiness): string {
	if (readiness.state !== "drained")
		return `Activation deferred (${readiness.reason}); keep the current supervisor running. No restart performed.`;
	return "No established gateway connections observed. Activation still requires owner-approved maintenance with admission paused; this point-in-time check does not prevent new connections. No restart performed.";
}

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
	inspectActivation: () => ActivationReadiness = inspectGatewayConnections,
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
		"Refreshed kit serve code; activation is a separate maintenance action.",
	);
	console.log(activationGuidance(inspectActivation()));
}

if (import.meta.main) {
	if (process.argv.includes("--check-activation")) {
		const readiness = inspectGatewayConnections();
		console.log(activationGuidance(readiness));
		if (readiness.state !== "drained") process.exitCode = 75;
	} else
		await refreshSwarm(
			`${process.env.HOME}/.claude/local-llm`,
			undefined,
			process.argv.includes("--dry-run"),
		);
}
