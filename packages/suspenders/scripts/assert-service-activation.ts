#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	inspectActivatedDispatch,
	inspectServiceGeneration,
} from "./lib/activated-dispatch.ts";
import { assertServiceActivation } from "./lib/service-activation-fence.ts";
import { readActivation, type ActivationReceipt } from "./lib/service-drift.ts";

export function assertBuckleActivation(
	unit: string,
	bytes = readFileSync(unit, "utf8"),
	initialInstall = false,
): void {
	const home = process.env.HOME ?? "";
	if (
		unit !==
		join(home, "Library/LaunchAgents/com.suspenders.buckle-spoke.plist")
	)
		throw new Error("activation refused: unrecognized active unit destination");
	const parsed = Bun.spawnSync(
		["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
		{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
	);
	if (parsed.exitCode !== 0)
		throw new Error("activation refused: candidate plist unreadable");
	const definition = JSON.parse(parsed.stdout.toString());
	if (definition.Label !== "com.suspenders.buckle-spoke")
		throw new Error("activation refused: candidate label mismatch");
	const path = join(home, ".config/klh/service-activation.json");
	let receipt: ActivationReceipt | undefined;
	try {
		receipt = readActivation(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const domain = `gui/${process.getuid()}`;
	const approved = receipt?.services.some(
		(service) => service.label === definition.Label,
	);
	let confirmedAbsent = false;
	if (initialInstall && !approved) {
		const result = Bun.spawnSync(
			["/bin/launchctl", "print", `${domain}/${definition.Label}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		confirmedAbsent =
			result.exitCode === 113 &&
			result.stderr.toString().includes("Could not find service");
	}
	const active = inspectActivatedDispatch(
		process.env.SUSPENDERS_PREFIX ?? join(home, ".claude/hooks/suspenders"),
	);
	if ((!initialInstall || approved) && (active.state !== "ok" || !active.root))
		throw new Error(
			"activation refused: immutable harness provenance unavailable",
		);
	const manifest =
		active.state === "ok" && active.root
			? readFileSync(
					join(active.root, "packages/suspenders/deploy/services.yaml"),
					"utf8",
				)
			: "";
	const service = receipt?.services.find(
		(service) => service.label === definition.Label,
	);
	if (service?.generation) {
		const generation = inspectServiceGeneration(service.generation);
		if (
			generation.state !== "ok" ||
			generation.revision !== service.generation.revision ||
			!generation.root ||
			!definition.ProgramArguments.includes(
				join(generation.root, "packages/buckle/src/server.bundle.js"),
			)
		)
			throw new Error(
				"activation refused: reviewed gateway generation integrity differs",
			);
	}
	assertServiceActivation(
		receipt,
		definition.Label,
		bytes,
		definition.ProgramArguments,
		manifest,
		domain,
		initialInstall,
		confirmedAbsent,
	);
}
/** Inspect the declared job identity, not an attacker-selected file basename. */
export function assertLaunchdActivation(
	unit: string,
	initialInstall = false,
): void {
	const bytes = readFileSync(unit, "utf8");
	const parsed = Bun.spawnSync(
		["/usr/bin/plutil", "-extract", "Label", "raw", "-o", "-", "-"],
		{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
	);
	if (
		parsed.exitCode !== 0 ||
		parsed.stdout.toString().trim() !== basename(unit, ".plist")
	)
		throw new Error(
			"activation refused: unit label does not match its destination",
		);
	if (parsed.stdout.toString().trim() === "com.suspenders.buckle-spoke")
		assertBuckleActivation(unit, bytes, initialInstall);
}

if (import.meta.main) {
	try {
		assertLaunchdActivation(
			process.argv[2],
			process.argv[3] === "--owner-initial-install",
		);
	} catch {
		console.error(
			"activation refused: missing or mismatched approved service receipt; running service untouched",
		);
		process.exitCode = 1;
	}
}
