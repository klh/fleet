// Machine-local, idempotent cutover: the IKEA hub keeps the Copilot seat,
// while the Mac keeps its existing non-Copilot fallback rungs.
// W1253 Amendment A: fleet config is JSON — reads resolve the .json law name
// first and fall back to the legacy .yaml NAME (whose content must already be
// JSON; real yaml needs the install migrate step first). Writes are atomic
// 0600 JSON upserts.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	preferCopilotHub,
	type UpstreamConfig,
} from "../src/copilot-hub-routes.ts";

const home = homedir();
const stackBase = join(home, ".config/klh/stack");

/** Read-both conf read: the .json name wins, the legacy .yaml NAME is tried
 *  second; content is always parsed as JSON (W1253). */
function readConfEither(base: string): unknown {
	const paths = [`${base}.json`, `${base}.yaml`];
	let last: unknown;
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			return JSON.parse(readFileSync(p, "utf8")) as unknown;
		} catch (error) {
			last = error;
		}
	}
	throw new Error(
		`config not readable: ${base}.json (W1253: fleet config is JSON — run the install migrate step for a legacy yaml)${last instanceof Error ? ` — ${last.message}` : ""}`,
	);
}
const spokeEnvPath = join(home, ".claude/local-llm/buckle-spoke.env");
const apply = process.argv.includes("--apply");
const stack = readConfEither(stackBase) as {
	hubs?: Record<
		string,
		{
			host?: string;
			buckle_port?: number;
			upstreams?: { groups?: Record<string, unknown> };
		}
	>;
};
const ikea = stack.hubs?.ikea;
if (!ikea?.host || !ikea.buckle_port || !ikea.upstreams?.groups)
	throw new Error("IKEA hub profile or model inventory missing");
const hubUrl = `http://${ikea.host}:${ikea.buckle_port}`;
const local = readConfEither(
	join(home, ".claude/local-llm/upstreams"),
) as UpstreamConfig;
const { config, routed } = preferCopilotHub(
	local,
	ikea.upstreams.groups,
	hubUrl,
);
if (!apply) {
	console.log(`${routed.length} Copilot groups can route through ${hubUrl}`);
	console.log("Pass --apply to install the peer-first ladder.");
	process.exit(0);
}
if (!/^IKEA_HUB_KEY=.+$/m.test(readFileSync(spokeEnvPath, "utf8")))
	throw new Error("IKEA_HUB_KEY is missing from the Mac Buckle environment");
// W1253: the cutover writes the .json law name; the backup keeps the ORIGINAL
// name the file was found under (.json or legacy .yaml)
const upstreamsJson = join(home, ".claude/local-llm/upstreams.json");
const backupPath = `${upstreamsJson}.pre-ikea-hub`;
if (!existsSync(backupPath)) {
	copyFileSync(upstreamsJson, backupPath);
	chmodSync(backupPath, 0o600);
}
const tempPath = `${upstreamsJson}.tmp-${process.pid}`;
try {
	writeFileSync(tempPath, `${JSON.stringify(config, null, "\t")}\n`, {
		mode: 0o600,
	});
	renameSync(tempPath, upstreamsJson);
	chmodSync(upstreamsJson, 0o600);
} catch (error) {
	if (existsSync(tempPath)) await Bun.file(tempPath).delete();
	throw error;
}
console.log(`${routed.length} Copilot groups now prefer ${hubUrl}`);
