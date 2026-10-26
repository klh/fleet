// hooks/bin/prefer.ts — W1354: the `prefer` CLI — the supported,
// coordinator-edit-gate-exempt write path for a repo's .prefer hub pin.
// The W834 gate classifies .prefer as a structural repo write (dispatch it
// instead), but routing pins are exactly the fix a lane or coordinator
// needs to make for itself; the verb makes that one write supported and
// validated. Quoted must=/prefer= stay SOFT hints (W1353 WARN) — hub= is
// what pins, so this first cut writes hub=/hub-url= only.
//   prefer set hub=nas
//   prefer set hub-url=https://hub.example.local:4101
//   prefer show
// Shims ride scripts/ensure-shims.ts (SHIM_NAMES) — installed next to
// coord/work/dispatch.
import { defineVerb, dieFor, runCli } from "../lib/verb-kit.ts";
import {
	preferSetTarget,
	readPreferSet,
	setPreferValue,
	validatePreferSet,
} from "../lib/prefer-set.ts";

const die = dieFor("prefer");

const set = defineVerb({
	name: "set",
	usage:
		"usage: prefer set <key>=<value> [...] — writes the repo .prefer (hub, hub-url)",
	minPos: 1,
	run: (parsed) => {
		const pairs = parsed.pos;
		if (!pairs.length) die("nothing to set — pass key=value pairs");
		const updates = pairs.map((pair) => {
			const eq = pair.indexOf("=");
			const key = eq < 0 ? "" : pair.slice(0, eq).trim();
			const value = eq < 0 ? "" : pair.slice(eq + 1).trim();
			if (eq < 0 || !key) die(`not key=value: '${pair}'`);
			const why = validatePreferSet(key, value);
			if (why) die(why);
			return { key, value };
		});
		const file = preferSetTarget(process.cwd());
		for (const { key, value } of updates) {
			const r = setPreferValue(file, key, value);
			console.log(`${r.action} ${key}=${value} in ${file}`);
		}
	},
});

const show = defineVerb({
	name: "show",
	usage: "usage: prefer show — print the current hub pin from the repo .prefer",
	run: () => {
		const file = preferSetTarget(process.cwd());
		const pins = readPreferSet(file);
		const rows = Object.entries(pins);
		if (!rows.length) {
			console.log(`no hub pin in ${file}`);
			return;
		}
		for (const [key, hit] of rows)
			console.log(`${key}=${hit?.value} (${file}:${hit?.line})`);
	},
});

await runCli({
	prog: "prefer",
	about: "usage: prefer set hub=<label> | show — repo .prefer hub pin (W1354)",
	verbs: [set, show],
	epilog: "a quoted must=/prefer= is a soft hint (dispatch WARNs); hub= is what pins",
});
