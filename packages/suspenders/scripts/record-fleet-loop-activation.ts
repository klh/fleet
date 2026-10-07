#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
} from "./install-services.ts";
import { inspectActivatedDispatch } from "./lib/activated-dispatch.ts";
import { processBirth } from "./lib/launch-fencing.ts";
import { recordExistingService } from "./lib/record-existing-service.ts";
import {
	digestUnit,
	readActivation,
	writeActivation,
	type ActivationReceipt,
} from "./lib/service-drift.ts";

/** Owner-invoked provenance registration; no launchd mutation or source synchronization. */
export function recordFleetLoopActivation(options: {
	prefix: string;
	home: string;
	bun?: string;
	repo?: string;
}): number {
	if (process.platform !== "darwin")
		throw new Error("launchd activation requires macOS");
	const active = inspectActivatedDispatch(options.prefix);
	if (active.state !== "ok" || !active.root)
		throw new Error("immutable activated generation unavailable");
	const packageRoot = join(active.root, "packages/suspenders");
	const manifest = join(packageRoot, "deploy/services.yaml");
	const spec = loadManifest(manifest).find(
		(service) => service.name === "fleet-loop",
	);
	if (!spec) throw new Error("fleet-loop absent from activated manifest");
	const expected = renderDarwin(
		spec,
		defaultRenderValues({ ...options, repo: options.repo ?? packageRoot }),
	);
	const parseUnit = (bytes: string): unknown => {
		const parsed = Bun.spawnSync(
			["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
			{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
		);
		if (parsed.exitCode !== 0) throw new Error("unit could not be parsed");
		return JSON.parse(parsed.stdout.toString());
	};
	const definition = parseUnit(expected) as {
		ProgramArguments: string[];
		KeepAlive?: boolean;
	};
	const unitPath = join(
		options.home,
		"Library/LaunchAgents/com.suspenders.fleet-loop.plist",
	);
	const path = join(options.home, ".config/klh/service-activation.json");
	let previous: ActivationReceipt | undefined;
	try {
		previous = readActivation(path);
	} catch {
		/* Unknown prior intent is not adopted. */
	}
	return recordExistingService(
		{
			schema: "fleet.service-activation.v1",
			platform: "darwin",
			domain: `gui/${process.getuid()}`,
			manifest,
			manifestSha256: digestUnit(readFileSync(manifest)),
			services: [],
		},
		{
			label: "com.suspenders.fleet-loop",
			unit: unitPath,
			unitSha256: digestUnit(readFileSync(unitPath)),
			arguments: definition.ProgramArguments,
			resident: definition.KeepAlive === true,
		},
		expected,
		previous,
		{
			parseUnit,
			read: (file) => readFileSync(file, "utf8"),
			birth: processBirth,
			inspect: (args) => {
				const p = Bun.spawnSync(args, {
					stdout: "pipe",
					stderr: "pipe",
					timeout: 3000,
				});
				return {
					code: p.exitCode,
					out: p.stdout.toString(),
					error: p.stderr.toString(),
				};
			},
			publish: (receipt) => writeActivation(path, receipt),
		},
	);
}
if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (key: string) => {
		const at = args.indexOf(key);
		return at < 0 ? undefined : args[at + 1];
	};
	if (!args.includes("--record-existing"))
		throw new Error("explicit --record-existing owner intent required");
	const home = process.env.HOME ?? "";
	const pid = recordFleetLoopActivation({
		home,
		prefix: value("--prefix") ?? join(home, ".claude/hooks/suspenders"),
		bun: value("--bun"),
		repo: value("--repo"),
	});
	console.log(
		`fleet-loop activation recorded; existing supervised pid ${pid}; no lifecycle action performed`,
	);
}
