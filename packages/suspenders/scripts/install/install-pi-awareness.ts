import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { z } from "zod";

const MetadataSchema = z.strictObject({
	type: z.literal("module"),
	fleetManaged: z.enum(["fleet-awareness-v1", "fleet-cockpit-v1"]),
	bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
	sdkVersion: z.string().max(40),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Result = {
	status: "ok" | "skipped" | "planned" | "conflict";
	action: "synced" | "current" | "none";
	note: string;
	bytes?: number;
};
type InstallOptions = { home?: string; piHome?: string; dryRun?: boolean };

export function installPiAwareness(
	options: InstallOptions = {},
): Promise<Result> {
	return installPiExtension(
		"fleet-awareness",
		fileURLToPath(
			new URL("../../pi-extensions/fleet-awareness/index.ts", import.meta.url),
		),
		options,
	);
}

export function installPiCockpit(
	repo: string,
	options: InstallOptions = {},
): Promise<Result> {
	return installPiExtension(
		"fleet-cockpit",
		join(repo, "extensions/fleet-cockpit/index.ts"),
		options,
	);
}

async function installPiExtension(
	name: "fleet-awareness" | "fleet-cockpit",
	source: string,
	options: InstallOptions,
): Promise<Result> {
	const label = name === "fleet-awareness" ? "awareness" : "cockpit";
	const manager = `${name}-v1` as const;
	const conflict = (): Result => ({
		status: "conflict",
		action: "none",
		note: `Pi ${label} user files or incompatible install preserved; resolve conflict before syncing`,
	});
	const piHome = options.piHome ?? join(options.home ?? homedir(), ".pi/agent");
	if (!existsSync(piHome))
		return { status: "skipped", action: "none", note: "Pi agent home absent" };
	if (name === "fleet-cockpit" && !existsSync(source))
		return {
			status: "skipped",
			action: "none",
			note: `Pi ${label} source absent`,
		};
	const dir = join(piHome, "extensions", name),
		entry = join(dir, "index.js"),
		metaPath = join(dir, "package.json");
	if (
		[join(piHome, "extensions"), dir, entry, metaPath].some((p) =>
			lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink(),
		) ||
		lstatSync(join(dir, "index.ts"), { throwIfNoEntry: false })
	)
		return conflict();
	let previous: z.infer<typeof MetadataSchema> | null = null;
	if (existsSync(metaPath)) {
		try {
			previous = MetadataSchema.parse(
				JSON.parse(readFileSync(metaPath, "utf8")),
			);
			if (previous.fleetManaged !== manager) return conflict();
		} catch {
			return conflict();
		}
	}
	if (
		existsSync(entry) &&
		(!previous || hash(readFileSync(entry, "utf8")) !== previous.bundleSha256)
	)
		return conflict();
	const versionFile = join(piHome, "install/current-version");
	if (
		existsSync(versionFile) &&
		readFileSync(versionFile, "utf8").trim() !== "1.5.0"
	)
		return conflict();
	if (options.dryRun)
		return {
			status: "planned",
			action: "none",
			note: `Would sync Node Pi ${label} bundle`,
		};
	const build = await Bun.build({
		entrypoints: [source],
		target: "node",
		format: "esm",
		minify: true,
	});
	if (!build.success || build.outputs.length !== 1)
		throw new Error(`Pi ${label} bundle build failed`);
	const code = `// fleet-managed:${name}:1\n${await build.outputs[0].text()}`;
	const metadata = MetadataSchema.parse({
		type: "module",
		fleetManaged: manager,
		bundleSha256: hash(code),
		sdkVersion: "1.5.0",
	});
	if (
		existsSync(entry) &&
		hash(readFileSync(entry, "utf8")) !== previous?.bundleSha256
	)
		return conflict();
	const current = existsSync(entry) && readFileSync(entry, "utf8") === code;
	if (!current) atomicWrite0600(entry, code);
	else chmodSync(entry, 0o600);
	const meta = `${JSON.stringify(metadata, null, 2)}\n`;
	if (!existsSync(metaPath) || readFileSync(metaPath, "utf8") !== meta)
		atomicWrite0600(metaPath, meta);
	else chmodSync(metaPath, 0o600);
	return {
		status: "ok",
		action: current ? "current" : "synced",
		note: `Node ${label} bundle synced; Pi 1.5.0 API required`,
		bytes: Buffer.byteLength(code),
	};
}
