// test/fixtures/verb-kit-demo.ts — a minimal kit CLI for spawn-level runCli
// tests (W651). Lives under test/fixtures/ (qlty-excluded); exercises the
// process door end to end: parse, help, die format, exit codes, after hook.
import { defineVerb, runCli, type VerbSpec } from "../../hooks/lib/verb-kit.ts";

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "add",
		usage: "usage: add <a> <b> --who <sid>",
		flags: ["--who"],
		minPos: 2,
		reqFlags: ["--who"],
		run: (p) => {
			console.log(
				JSON.stringify({
					verb: p.name,
					pos: p.pos,
					who: p.flag("--who"),
					allWho: p.all("--who"),
				}),
			);
		},
	}),
	defineVerb({
		name: "list",
		lax: true,
		switches: ["--json"],
		run: (p) => {
			console.log(JSON.stringify({ verb: p.name, rest: p.rest }));
		},
	}),
	// the embedded-main door: a numeric run result is the process exit code
	defineVerb({
		name: "zap",
		run: () => 3,
	}),
];

await runCli({
	prog: "demo",
	about: "demo — verb-kit fixture.",
	verbs: VERBS,
	after: (n) => console.error(`after:${n}`),
});
