// tests/helpers/client-discovery-probe.ts — W1731 helpers for
// tests/client-discovery.e2e.ts (spec shape law: the spec file carries only
// imports and test registrations). probeClient() runs the REAL discovery
// seam — detectClient() then completionClient() over a seeded launch fact —
// in a child process whose environment is the scenario's signals over the
// parent env with every detector-read key scrubbed: a nested agent inherits
// exactly what its parent exported, so the child env IS the inherited
// environment under test, whatever agent runs this suite. The transcript
// builders feed the in-process claim-check verdict.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./check-deps-fixture.ts";

const LIB = join(REPO_ROOT, "packages", "suspenders", "hooks", "lib");

/** Every env key @vercel/detect-agent@1.2.7 reads (dist/index.js). */
export const DETECTOR_ENV_KEYS: readonly string[] = [
	"AI_AGENT",
	"ANTIGRAVITY_AGENT",
	"AUGMENT_AGENT",
	"CLAUDECODE",
	"CLAUDE_CODE",
	"CLAUDE_CODE_IS_COWORK",
	"CODEX_CI",
	"CODEX_SANDBOX",
	"CODEX_THREAD_ID",
	"COPILOT_ALLOW_ALL",
	"COPILOT_GITHUB_TOKEN",
	"COPILOT_MODEL",
	"CURSOR_AGENT",
	"CURSOR_EXTENSION_HOST_ROLE",
	"CURSOR_TRACE_ID",
	"GEMINI_CLI",
	"OPENCODE",
	"OPENCODE_CLIENT",
	"REPL_ID",
];

/** A seeded lane.<sid>.executor fact: value + the writer's source. */
export interface LaunchFact {
	value: string;
	source: string;
}

export interface ClientProbe {
	/** detectClient(): the canonical registry id, or null. */
	detected: string | null;
	/** completionClient(): the client whose reader parses the transcript. */
	client: string;
	stdout: string;
	stderr: string;
}

const childSource = (launch: LaunchFact | null): string => `
const { Database } = await import("bun:sqlite");
const { detectClient } = await import(${JSON.stringify(join(LIB, "executors", "detect.ts"))});
const { completionClient } = await import(${JSON.stringify(join(LIB, "work", "work-completion-record.ts"))});
const db = new Database(":memory:");
db.run("CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT)");
const launch = ${JSON.stringify(launch)};
if (launch) db.query("INSERT INTO facts (key, value, source) VALUES (?, ?, ?)").run("lane.probe.executor", launch.value, launch.source);
const detected = await detectClient();
console.log(JSON.stringify({ detected, client: completionClient(db, "probe", detected) }));
`;

/** Run discovery + completion resolution under `signals` (the inherited
 *  agent env) and an optional registered launch fact. */
export function probeClient(
	signals: Record<string, string>,
	launch: LaunchFact | null = null,
): ClientProbe {
	const home = mkdtempSync(join(tmpdir(), "w1731-discovery-"));
	try {
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry) => !DETECTOR_ENV_KEYS.includes(entry[0]),
			),
		);
		const p = spawnSync(process.execPath, ["-e", childSource(launch)], {
			env: {
				...inherited,
				HOME: home,
				GOVERNOR_STORE_URL: "local",
				...signals,
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		const stdout = p.stdout ?? "";
		const stderr = p.stderr ?? "";
		if (p.status !== 0) throw new Error(`probe exited ${p.status}: ${stderr}`);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
			detected: string | null;
			client: string;
		};
		return { detected: result.detected, client: result.client, stdout, stderr };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const CLAIM = "All tests pass.";
const at = (t: number): string => new Date(t).toISOString();
const jsonl = (rows: unknown[]): string =>
	`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** A claude-code transcript: an own `bun test` call, its passing result,
 *  then the assistant's test-pass claim — valid evidence read as claude. */
export const claudePassingTranscript = (t0: number): string =>
	jsonl([
		{
			type: "assistant",
			timestamp: at(t0),
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "run-1",
						name: "Bash",
						input: { command: "bun test product.test.ts" },
					},
				],
			},
		},
		{
			type: "user",
			timestamp: at(t0 + 1_000),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "run-1",
						content: "3 pass\n0 fail",
					},
				],
			},
		},
		{
			type: "assistant",
			timestamp: at(t0 + 2_000),
			message: { role: "assistant", content: [{ type: "text", text: CLAIM }] },
		},
	]);

/** One assistant test-pass claim per registered transcript dialect and no
 *  run anywhere — claim visibility read under every client identity. */
export const claimOnlyTranscripts = (t0: number): string[] => [
	jsonl([
		{
			type: "assistant",
			timestamp: at(t0),
			message: { role: "assistant", content: [{ type: "text", text: CLAIM }] },
		},
	]),
	jsonl([
		{
			type: "response_item",
			timestamp: at(t0),
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: CLAIM }],
			},
		},
	]),
	jsonl([
		{ type: "assistant.message", timestamp: at(t0), data: { content: CLAIM } },
	]),
];
