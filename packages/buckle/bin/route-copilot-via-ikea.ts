// Machine-local, idempotent cutover: the IKEA hub keeps the Copilot seat,
// while the Mac keeps its existing non-Copilot fallback rungs.
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
const stackPath = join(home, ".config/klh/stack.yaml");
const upstreamsPath = join(home, ".claude/local-llm/upstreams.yaml");
const spokeEnvPath = join(home, ".claude/local-llm/buckle-spoke.env");
const apply = process.argv.includes("--apply");
const stack = Bun.YAML.parse(readFileSync(stackPath, "utf8")) as {
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
const local = Bun.YAML.parse(
	readFileSync(upstreamsPath, "utf8"),
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
const backupPath = `${upstreamsPath}.pre-ikea-hub`;
if (!existsSync(backupPath)) {
	copyFileSync(upstreamsPath, backupPath);
	chmodSync(backupPath, 0o600);
}
const tempPath = `${upstreamsPath}.tmp-${process.pid}`;
try {
	writeFileSync(tempPath, Bun.YAML.stringify(config), { mode: 0o600 });
	renameSync(tempPath, upstreamsPath);
	chmodSync(upstreamsPath, 0o600);
} catch (error) {
	if (existsSync(tempPath)) await Bun.file(tempPath).delete();
	throw error;
}
console.log(`${routed.length} Copilot groups now prefer ${hubUrl}`);
