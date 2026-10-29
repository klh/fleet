#!/usr/bin/env bun
// scripts/gate-bench-latency.ts — tool-call gate wall time, per-call vs the
// hub governor daemon (hub-of-one phase 5). Fully isolated: a scratch HOME,
// a scratch git repo and its own store-server on a free port — it never
// touches the live governor.db (a live-HOME bench opens real leases and
// consults; that is how the first measurement polluted the plane).
//
//   bun scripts/gate-bench-latency.ts [--n 9] [--events pre-read,pre-bash,pre-files,push]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, scratchWorld, waitUp } from "@klh/test-kit";

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const n = Math.max(1, Number(flag("--n", "9")));
const events = flag("--events", "pre-read,pre-bash,pre-files,push").split(",");
const hooks = join(import.meta.dir, "..", "hooks");

const world = scratchWorld({ prefix: "gate-bench-" });
const file = join(world.repo, "target.txt");
writeFileSync(file, "alpha\nbeta\n");
const port = await freePort();
const store = `http://127.0.0.1:${port}`;
const reg = join(world.home, ".cache", "claude-governor");
mkdirSync(reg, { recursive: true });
writeFileSync(join(reg, "store.url"), store);
const server = Bun.spawn(
	["bun", join(hooks, "bin", "store-server.ts"), "--port", String(port)],
	{
		env: { ...world.env, SUSPENDERS_MDNS: "0", GOVERNOR_STORE_TOKEN: "" },
		stdout: "ignore",
		stderr: "ignore",
	},
);

const payloadFor = (event: string): string => {
	const base = { session_id: "gate-bench-sid", cwd: world.repo };
	if (event === "pre-bash")
		return JSON.stringify({
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "true" },
		});
	if (event === "pre-files")
		return JSON.stringify({
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: file, old_string: "beta", new_string: "beta" },
		});
	return JSON.stringify({
		...base,
		hook_event_name: event === "push" ? "PostToolUse" : "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: file },
	});
};

const pct = (xs: number[], p: number): number => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function sample(event: string, daemon: string): Promise<number[]> {
	const ms: number[] = [];
	for (let i = 0; i <= n; i++) {
		const t0 = performance.now();
		const p = Bun.spawn(["bun", join(hooks, "gate.ts"), event], {
			cwd: world.repo,
			stdin: new Blob([payloadFor(event)]),
			stdout: "ignore",
			stderr: "ignore",
			env: {
				...world.env,
				GOVERNOR_STORE_URL: store,
				SUSPENDERS_GATE_DAEMON: daemon,
				SUSPENDERS_MDNS: "0",
			},
		});
		await p.exited;
		if (i > 0) ms.push(performance.now() - t0); // sample 0 = warm-up
	}
	return ms;
}

try {
	await waitUp(`${store}/health`);
	for (const event of events)
		for (const [label, daemon] of [
			["per-call", "0"],
			["daemon", "1"],
		] as const) {
			const ms = await sample(event, daemon);
			console.log(
				`${event.padEnd(10)} ${label.padEnd(8)} n=${n} min=${pct(ms, 0).toFixed(0)}ms p50=${pct(ms, 50).toFixed(0)}ms p90=${pct(ms, 90).toFixed(0)}ms`,
			);
		}
} finally {
	server.kill();
	await server.exited;
	world.clean();
}
