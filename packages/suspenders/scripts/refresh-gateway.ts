// Code-only recovery of the minimal swarm; config and keys are operator-owned.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function refreshGateway(
	runtime: string,
	root = join(import.meta.dir, "../.."),
	dryRun = false,
): Promise<void> {
	const files = ["swarm.ts", "spawner.ts"];
	const originals = await Promise.all(
		files.map((file) => readFile(join(runtime, file), "utf8")),
	);
	let [swarm, spawner] = originals;
	// Source-tree DRY exports cannot resolve from the flattened runtime home.
	if (spawner.includes('export * from "../belt/bin/spawner.ts"'))
		spawner = await readFile(join(root, "belt/bin/spawner.ts"), "utf8");
	if (swarm.includes('from "./supervisor.ts"'))
		throw new Error(
			"advanced supervisor already owns LiteLLM; use --refresh-supervisor",
		);
	if (!swarm.includes('from "./gateway-supervision.ts"')) {
		const anchor = "async function serveOnce(): Promise<void> {";
		if (!swarm.includes(anchor))
			throw new Error("unsupported swarm: no serveOnce anchor");
		swarm = swarm.replace(
			anchor,
			`import { gatewaySupervisor } from "./gateway-supervision.ts";\nconst ensureGateway = gatewaySupervisor(undefined, serveLog);\n\n${anchor}\n\tawait ensureGateway();`,
		);
	}
	if (!spawner.includes('from "./memory-policy.ts"')) {
		const flags = "...(s.flags ?? []),";
		if (!spawner.includes(flags))
			throw new Error("unsupported spawner: no flags anchor");
		spawner = spawner.replace(
			'import type { Specialist } from "./registry.ts";',
			'import type { Specialist } from "./registry.ts";\nimport { modelBudgetGb, rapidMemoryArgs } from "./memory-policy.ts";',
		);
		spawner = spawner.replace(
			flags,
			`${flags}\n\t\t\t...rapidMemoryArgs(s.ram_gb),`,
		);
		spawner = spawner.replace(
			"if (wired > WIRED_GUARD_GB)",
			"if (wired + modelBudgetGb(s.ram_gb) > WIRED_GUARD_GB)",
		);
		spawner = spawner.replace(
			"// Stale row (recycled pid or wedged load) — clear and spawn fresh.\n\t\t\t\tclearLedgerPort(s.port);",
			"return { up: false, cold: false, waitedMs: 0, error: `live loading pid " +
				"${" +
				"row.pid} exceeded deadline; refusing duplicate spawn` };",
		);
	}
	// W506: upgrade the minimal supervisor's two model launch paths without
	// replacing its gateway ownership or any operator configuration.
	spawner = await readFile(join(root, "belt/bin/spawner.ts"), "utf8");
	if (!swarm.includes("spawnReserved")) {
		swarm = swarm.replace(
			"mlxLogPath, spawnArgs }",
			"mlxLogPath, spawnArgs, spawnReserved }",
		);
		const start = swarm.indexOf("\t\tconst log = mlxLogPath(s.port);");
		const end = swarm.indexOf("\n\t}\n", start);
		if (start < 0 || end < 0)
			throw new Error("unsupported swarm boot admission anchor");
		swarm = `${swarm.slice(0, start)}\t\ttry { spawnReserved(s).unref(); }\n\t\tcatch (error) { console.error(String(error)); }${swarm.slice(end)}`;
		const direct =
			'const proc = Bun.spawn(t.argv, { stdin: "ignore", stdout: fd, stderr: fd });';
		if (!swarm.includes(direct))
			throw new Error("unsupported swarm resident admission anchor");
		swarm = swarm.replace(
			direct,
			`const specialist = SPECIALISTS.find((s) => s.port === t.port);
\tlet proc: ReturnType<typeof Bun.spawn>;
\ttry { proc = specialist ? spawnReserved(specialist) : Bun.spawn(t.argv, { stdin: "ignore", stdout: fd, stderr: fd }); }
\tcatch (error) { closeSync(fd); serveLog(String(error)); return; }`,
		);
	}
	if (dryRun) {
		console.log("Would refresh gateway supervision and model limits");
		return;
	}
	await mkdir(runtime, { recursive: true });
	await copyFile(
		join(root, "belt/bin/spawn-admission.ts"),
		join(runtime, "spawn-admission.ts"),
	);
	for (const file of ["gateway-supervision.ts", "memory-policy.ts"])
		await copyFile(join(root, "local-llm", file), join(runtime, file));
	await copyFile(
		join(root, "belt/bin/litellm-target.ts"),
		join(runtime, "litellm-target.ts"),
	);
	const upgraded = [swarm, spawner];
	for (let i = 0; i < files.length; i++) {
		const path = join(runtime, files[i]);
		if (upgraded[i] === originals[i]) continue;
		if ((await readFile(path, "utf8")) !== originals[i])
			throw new Error(`${files[i]} changed during upgrade; retry`);
		await writeFile(`${path}.gateway-backup`, originals[i]);
		await writeFile(`${path}.gateway-next`, upgraded[i]);
		await rename(`${path}.gateway-next`, path);
	}
	console.log(
		"Refreshed gateway supervision and model limits; restart com.suspenders.local-llm to activate",
	);
}

if (import.meta.main)
	await refreshGateway(
		`${process.env.HOME}/.claude/local-llm`,
		undefined,
		process.argv.includes("--dry-run"),
	);
