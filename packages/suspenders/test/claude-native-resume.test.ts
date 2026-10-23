import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = Bun.which("claude");
test.skipIf(!binary)(
	"installed Claude resumes persisted history under the same native UUID without a fork",
	async () => {
		const home = mkdtempSync(join(tmpdir(), "native-resume-contract-"));
		const session = crypto.randomUUID();
		const histories: number[] = [];
		const frame = (value: { type: string; [key: string]: unknown }) =>
			`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return new Response(null);
				const body = (await request.json()) as {
					model: string;
					messages: unknown[];
				};
				if (new URL(request.url).pathname.includes("count_tokens"))
					return Response.json({ input_tokens: 1 });
				histories.push(body.messages.length);
				return new Response(
					[
						frame({
							type: "message_start",
							message: {
								id: "fixture-message",
								type: "message",
								role: "assistant",
								model: body.model,
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 1, output_tokens: 0 },
							},
						}),
						frame({
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						}),
						frame({
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "ok" },
						}),
						frame({ type: "content_block_stop", index: 0 }),
						frame({
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						}),
						frame({ type: "message_stop" }),
					].join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const settings = join(home, "settings.json");
			writeFileSync(
				settings,
				JSON.stringify({
					disableAllHooks: true,
					env: {
						ANTHROPIC_BASE_URL: base,
						ANTHROPIC_AUTH_TOKEN: "fixture-only",
					},
				}),
				{ mode: 0o600 },
			);
			for (const resume of [false, true]) {
				const child = Bun.spawn(
					[
						binary ?? "claude",
						"--bare",
						"-p",
						resume
							? "Continue reply ok"
							: "Remember fixture history and reply ok",
						"--settings",
						settings,
						"--strict-mcp-config",
						"--mcp-config",
						'{"mcpServers":{}}',
						"--tools",
						"",
						"--output-format",
						"json",
						...(resume ? ["--resume", session] : ["--session-id", session]),
					],
					{
						cwd: home,
						env: {
							HOME: home,
							PATH: process.env.PATH,
							ANTHROPIC_API_KEY: "fixture-only",
							ANTHROPIC_BASE_URL: base,
							CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
							DISABLE_AUTOUPDATER: "1",
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const timer = setTimeout(() => child.kill(), 15_000);
				const [out, err, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				clearTimeout(timer);
				expect(err).toBe("");
				expect(code).toBe(0);
				const result = JSON.parse(out);
				expect(result.session_id).toBe(session);
				expect(result.result).toBe("ok");
			}
			expect(histories).toHaveLength(2);
			expect(histories[1]).toBeGreaterThan(histories[0]);
		} finally {
			server.stop(true);
			rmSync(home, { recursive: true, force: true });
		}
	},
	35_000,
);
