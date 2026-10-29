// hooks/coord/project-registry-cli.ts — fork E: `coord project
// register|unregister|list`, the verb surface over the hub's fleet-loop
// project registry (stack.json fleet_loop.projects — machine conf, atomic
// 0600 writes). The running controller re-reads the registry every
// boundary, so a register takes effect on its next cycle (no reload).
import { resolve } from "node:path";
import {
	listRegistry,
	registerProject,
	unregisterProject,
} from "../lib/fleet-loop/project-registry.ts";
import { STACK_PATH } from "../lib/stack-config.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";
import { die } from "./shared.ts";

const register = defineVerb({
	name: "register",
	usage:
		"usage: project register [path] [--glob g] [--ladder cmd] [--dispatch-cmd cmd] [--main b] [--lane-target n] [--disabled]",
	flags: ["--glob", "--ladder", "--dispatch-cmd", "--main", "--lane-target"],
	switches: ["--disabled", "--json"],
});
const unregister = defineVerb({
	name: "unregister",
	usage: "usage: project unregister [path]",
	switches: ["--json"],
});
const list = defineVerb({
	name: "list",
	usage: "usage: project list [--json]",
	switches: ["--json"],
});
const SPECS = { register, unregister, list } as const;

const isRegistryVerb = (v: string | undefined): v is keyof typeof SPECS =>
	v !== undefined && Object.hasOwn(SPECS, v);

/** Handles register|unregister|list; false = not a registry verb (the
 *  caller keeps its own project sub-verbs). */
export function cmdProjectRegistry(rest: string[]): boolean {
	const sub = rest[0];
	if (!isRegistryVerb(sub)) return false;
	runRegistryVerb(sub, rest);
	return true;
}

function runRegistryVerb(sub: keyof typeof SPECS, rest: string[]): void {
	const spec = SPECS[sub];
	if (rest.includes("--help")) {
		console.log(renderVerbHelp(spec));
		return;
	}
	const out = parseVerb(spec, rest.slice(1));
	if (!out.ok) die(out.message || "usage: project register|unregister|list");
	const p = out.parsed;
	const json = p.rest.includes("--json");
	const path = resolve(p.pos[0] ?? process.cwd());
	const conf = STACK_PATH();
	try {
		if (sub === "list") {
			const rows = listRegistry(conf);
			if (json) console.log(JSON.stringify(rows, null, 2));
			else if (rows.length === 0)
				console.log(
					`no registered projects in ${conf} — the controller supervises its own --repo only`,
				);
			else
				for (const r of rows)
					console.log(
						`${r.enabled === false ? "–" : "·"} ${r.path}${r.lane_target !== undefined ? ` cap=${r.lane_target}` : ""}${r.glob ? ` glob=${r.glob}` : ""}`,
					);
			return;
		}
		if (sub === "unregister") {
			const gone = unregisterProject(path, { path: conf });
			if (!gone) die(`project unregister: no registry row for ${path}`);
			console.log(
				json ? JSON.stringify({ path, removed: true }) : `unregistered ${path}`,
			);
			return;
		}
		const capRaw = p.flag("--lane-target");
		const cap = capRaw === null ? undefined : Number(capRaw);
		if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0))
			die("project register: --lane-target must be a whole number ≥ 0");
		const verdict = registerProject(
			{
				path,
				...(p.flag("--glob") ? { glob: p.flag("--glob") as string } : {}),
				...(p.flag("--ladder") ? { ladder: p.flag("--ladder") as string } : {}),
				...(p.flag("--dispatch-cmd")
					? { dispatch_cmd: p.flag("--dispatch-cmd") as string }
					: {}),
				...(p.flag("--main") ? { main: p.flag("--main") as string } : {}),
				...(cap !== undefined ? { lane_target: cap } : {}),
				enabled: !p.rest.includes("--disabled"),
			},
			{ path: conf },
		);
		console.log(
			json ? JSON.stringify({ path, result: verdict }) : `${verdict} ${path}`,
		);
	} catch (e) {
		die(`project ${sub}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
