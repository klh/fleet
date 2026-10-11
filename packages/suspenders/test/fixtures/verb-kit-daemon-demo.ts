// test/fixtures/verb-kit-daemon-demo.ts — the W656.3 default-verb door
// fixture: a daemon-shaped CLI (compose/launchd spawn BARE) whose registry is
// once|loop with defaultVerb "loop". Exercises the bare/flag-first door end
// to end at spawn level.
import { defineVerb, runCli, type VerbSpec } from "../../hooks/lib/verb-kit.ts";

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "once",
		usage: "usage: once — one cycle; exits 2 on a degraded cycle",
		run: () => {
			console.log(JSON.stringify({ verb: "once" }));
		},
	}),
	defineVerb({
		name: "loop",
		usage: "usage: loop — cycle forever (daemon default)",
		flags: ["--interval"],
		run: (p) => {
			console.log(JSON.stringify({ verb: "loop", interval: p.flag("--interval") }));
		},
	}),
];

await runCli({
	prog: "daemon-demo",
	about: "daemon-demo — W656.3 default-verb fixture.",
	verbs: VERBS,
	defaultVerb: "loop",
});
