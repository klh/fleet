import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

function nativeCompletion(dialect: string): void {
	const copilot = dialect.startsWith("copilot");
	const asyncRead = dialect === "copilot-async";
	const f = cliFixture(`native-completion-${dialect}`);
	try {
		const sid = "custom-completion-owner";
		const foreign = "another-completion-owner";
		const native = "c47f0616-d45f-4ab0-9fa4-32853c568b25";
		for (const owner of [sid, foreign])
			expect(
				f.run("coord.ts", ["bootstrap", "--as", owner, "--role", "worker"])
					.code,
			).toBe(0);
		const item =
			f
				.run("work.ts", ["add", "Native transcript evidence fixture"])
				.out.match(/W\d+/)?.[0] ?? "";
		const take = f.run("work.ts", ["take", item, "--as", sid]);
		expect(take.code).toBe(0);
		// W1731: the launcher-registered identity picks the evidence reader,
		// never the ambient client environment this suite inherits.
		f.ins(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
			[`lane.${sid}.executor`, copilot ? "copilot" : "codex", Date.now()],
		);
		const token = take.out.match(/claim token: ([a-f0-9]{48})/)?.[1] ?? "";
		const git = (...args: string[]) => {
			const p = Bun.spawnSync(["git", "-C", f.REPO, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(p.exitCode, p.stderr.toString()).toBe(0);
			return p.stdout.toString().trim();
		};
		writeFileSync(join(f.REPO, "product.ts"), "export const value = 42;\n");
		writeFileSync(
			join(f.REPO, "product.test.ts"),
			'import {test,expect} from "bun:test";import{value}from"./product.ts";test("product",()=>expect(value).toBe(42));\n',
		);
		git("add", "product.ts", "product.test.ts");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"Implement product and real regression",
		);
		const sha = git("rev-parse", "HEAD");
		const command = "bun test product.test.ts";
		const began = new Date().toISOString();
		const run = Bun.spawnSync([process.execPath, "test", "product.test.ts"], {
			cwd: f.REPO,
			env: { ...process.env, HOME: f.HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString() + run.stderr.toString();
		expect(output).toContain("1 pass");
		const directory = join(
			f.HOME,
			copilot
				? `.copilot/session-state/${native}`
				: ".codex/sessions/2026/01/01",
		);
		mkdirSync(directory, { recursive: true });
		const transcript = join(
			directory,
			copilot ? "events.jsonl" : `rollout-2026-01-01T00-00-00-${native}.jsonl`,
		);
		const frames = copilot
			? [
					{
						type: "assistant.message",
						timestamp: began,
						data: {
							content: "",
							toolRequests: [
								{
									toolCallId: "real-run",
									name: "bash",
									arguments: { command },
								},
							],
						},
					},
					...(asyncRead
						? [
								{
									type: "tool.execution_complete",
									timestamp: began,
									data: {
										toolCallId: "real-run",
										success: true,
										result: {
											content:
												"<command with shellId: 1 is still running after 30 seconds.>",
										},
									},
								},
								{
									type: "assistant.message",
									timestamp: began,
									data: {
										toolRequests: [
											{
												toolCallId: "real-read",
												name: "read_bash",
												arguments: { shellId: "1", delay: 120 },
											},
										],
									},
								},
							]
						: []),
					{
						type: "tool.execution_complete",
						timestamp: new Date().toISOString(),
						data: {
							toolCallId: asyncRead ? "real-read" : "real-run",
							success: true,
							result: {
								content: `${output}\n<shellId: 1 completed with exit code ${run.exitCode}>`,
							},
						},
					},
				]
			: [
					{ type: "session_meta", payload: { id: native, cwd: f.REPO } },
					{
						type: "response_item",
						timestamp: began,
						payload: {
							type: "custom_tool_call",
							name: "exec",
							call_id: "real-run",
							input: `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));`,
						},
					},
					{
						type: "response_item",
						timestamp: new Date().toISOString(),
						payload: {
							type: "custom_tool_call_output",
							call_id: "real-run",
							output: [{ type: "text", text: `Script completed\n${output}` }],
						},
					},
				];
		writeFileSync(
			transcript,
			`${frames.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		const summary =
			"All tests pass. Implemented the product and verified its actual native-session regression evidence.";
		expect(
			f.run("coord.ts", [
				"capsule",
				"set",
				"--as",
				sid,
				"--item",
				item,
				"--checkpoint",
				sha,
				"--done",
				summary,
				"--next",
				"Review",
			]).code,
		).toBe(0);
		const bind = (owner: string) =>
			f.seed(
				`import{touchSessionHeartbeat}from${JSON.stringify(join(import.meta.dir, "../hooks/lib/session-bridge.ts"))};touchSessionHeartbeat(${JSON.stringify(owner)},${JSON.stringify(transcript)});`,
			);
		const done = () =>
			f.run("work.ts", [
				"done",
				item,
				"--sha",
				sha,
				"--token",
				token,
				"--summary",
				summary,
			]);
		bind(foreign);
		const unbound = done();
		expect(unbound.code).not.toBe(0);
		expect(unbound.err).toContain("no test run found");
		bind(sid);
		const project = JSON.parse(
			f.run("work.ts", ["show", item, "--json"]).out,
		).project;
		f.ins("UPDATE sessions SET project = ? WHERE sid = ?", [
			"foreign-project",
			sid,
		]);
		const wrongProject = done();
		expect(wrongProject.code).not.toBe(0);
		expect(wrongProject.err).toContain("no test run found");
		f.ins("UPDATE sessions SET project = ? WHERE sid = ?", [project, sid]);
		const complete = done();
		expect(complete.code, complete.err).toBe(0);
		const record = JSON.parse(
			f.run("work.ts", ["show", item, "--json"]).out,
		).completion;
		expect(record.commit_sha).toBe(sha);
		expect(record.completed_by).toBe(sid);
	} finally {
		f.cleanup();
	}
}

// biome-ignore format: Keep the existing test identity visible to the line-based closing-diff scanner.
test("custom Fleet SID completion uses only its project-bound native transcript", () => nativeCompletion("codex"), 20_000);

test(
	"custom Fleet SID completion uses only its project-bound Copilot events",
	() => nativeCompletion("copilot"),
	20_000,
);

test(
	"custom Fleet SID completion accepts own Copilot asynchronous test evidence",
	() => nativeCompletion("copilot-async"),
	20_000,
);
