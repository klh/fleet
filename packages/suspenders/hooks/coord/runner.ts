import { defineVerb, runCli } from "../lib/verb-kit.ts";
import { runRunnerCommand } from "../lib/runners/api/cli-command.ts";

const shared = ["--url", "--key-file"];
const descriptions: Record<string, string> = {
	list: "List permitted jobs",
	admit: "Admit a host-approved profile",
	read: "Read one bounded event page",
	submit: "Submit using a stable request ID",
	resume: "Resume a job",
	abort: "Fence and stop a job",
	attach: "Attach a reader without consuming",
	replay: "Consume the reader's next page",
	detach: "Detach the reader without stopping work",
};
const definitions: [string, string[], string[]][] = [
	["list", ["--after"], []],
	["admit", ["--profile", "--run-id"], ["--profile"]],
	["read", ["--since"], []],
	["submit", ["--text", "--request-id"], ["--text", "--request-id"]],
	["resume", [], []],
	["abort", [], []],
	...["attach", "replay", "detach"].map(
		(name): [string, string[], string[]] => [name, ["--reader"], ["--reader"]],
	),
];
export async function cmdRunner(rest: string[]) {
	await runCli({
		prog: "coord runner",
		about:
			"Authenticated durable jobs; credential identity determines ownership",
		argv: ["coord", "runner", ...rest],
		verbs: definitions.map(([name, flags, reqFlags]) =>
			defineVerb({
				name,
				help: descriptions[name],
				flags: [...shared, ...flags],
				reqFlags,
				switches: ["--json", "--ndjson"],
				minPos: ["list", "admit"].includes(name) ? 0 : 1,
				usage: `usage: runner ${name} ${["list", "admit"].includes(name) ? "" : "<run-id> "}[--url URL] [--key-file FILE] [--json | --ndjson]`,
				run: (parsed) => runRunnerCommand(name, parsed),
			}),
		),
	});
}
