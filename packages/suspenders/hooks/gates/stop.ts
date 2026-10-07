// hooks/gates/stop.ts — Stop: the claim-done gate. Re-runs syntax gates over
// changed files + conflict-marker check before the turn may end. TS fixes
// from the hooks-review: porcelain -z parsing (spaces/renames safe),
// JSON.stringify-built payloads (no printf-JSON corruption), bounded loop
// matching the list cap, files newer than a cap only.
// W14: re-verify runs filesCheck IN-PROCESS — the old loop spawned one
// `bun gate.ts post-files` per changed file (up to 50 bun processes per Stop).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { openGovernorDb } from "../lib/govdb.ts";
import { allow, feedback, type HookInput } from "../lib/hookio.ts";
import { laneCompletion } from "../lib/lane-completion.ts";
import { run } from "../lib/run.ts";
import {
	pendingTurnMessages,
	turnBoundaryFeedback,
	turnBoundarySid,
} from "../lib/turn-boundary.ts";
import { filesCheck } from "./files.ts";

const CODE_EXT =
	/\.(json|py|sh|bash|zsh|dash|ts|tsx|js|jsx|mjs|cjs|mts|cts|yaml|yml|toml)$/i;

export function stopGate(hook: HookInput): never {
	const incomplete = laneCompletion(hook);
	if (incomplete) feedback(incomplete);

	// W516 turn-boundary drain (the amp M3 lift): operator direct-messages
	// queue while the lane works and are processed HERE, at the turn
	// boundary, instead of injected mid-turn. laneCompletion stays first —
	// completion enforcement outranks inbox draining. No lane context or no
	// control plane → nothing to drain, the gate allows.
	const drainCwd = hook.cwd ?? "";
	if (drainCwd && existsSync(drainCwd)) {
		const laneSid = turnBoundarySid(hook);
		if (laneSid) {
			try {
				const f = turnBoundaryFeedback(
					pendingTurnMessages(openGovernorDb(), laneSid),
					laneSid,
				);
				if (f) feedback(f);
			} catch {
				// no control plane reachable — the drain is a lane concern only
			}
		}
	}

	// W497: the session-end knowledge ask — ONCE per session, only for
	// substantive ones (transcript > 20KB): block this stop and make the
	// agent either donate its learnings or declare none. Self-resolving: the
	// marker prevents another knowledge ask; repeated stops still verify work.
	const h = hook as HookInput & {
		session_id?: string;
		transcript_path?: string;
	};
	if (h.session_id && h.transcript_path && existsSync(h.transcript_path)) {
		const top = run(
			"git",
			["-C", hook.cwd ?? ".", "rev-parse", "--show-toplevel"],
			{
				cwd: hook.cwd,
			},
		);
		if (top.ok && statSync(h.transcript_path).size > 20_000) {
			const dir = `${top.out.trim()}/.fleet/session-learnings`;
			const marker = `${dir}/${h.session_id}`;
			if (!existsSync(marker)) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(marker, new Date().toISOString());
				feedback(
					'Session-end knowledge ask (asked once): did you learn anything valuable this session — a lesson another lane would need, a gotcha, a correction? If yes, write it NOW: coord fact set lesson.<topic> "<fact>" (durable, immediate) or coord knowledge-enqueue "<text>" (distill queue). If nothing valuable: reply one line and stop — exit is fine.',
				);
			}
		}
	}
	const cwd = hook.cwd ?? "";
	if (!cwd || !existsSync(cwd)) allow();
	if (!run("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok) allow();

	// -z: NUL-separated, rename targets after " -> ", quoted paths intact
	const st = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
		cwd,
		encoding: "buffer",
	});
	if (st.status !== 0) allow();
	const fields = st.stdout.toString("utf8").split("\0").filter(Boolean);

	const files = new Set<string>();
	for (const f of fields) {
		let path = f.slice(3); // strip XY + space
		const arrow = path.indexOf(" -> ");
		if (arrow !== -1) path = path.slice(arrow + 4); // renamed: check the TARGET
		if (!path || path.includes(".claude/")) continue;
		if (CODE_EXT.test(path)) files.add(path);
	}
	if (files.size === 0) allow();

	const failures: string[] = [];

	// unmerged paths block outright
	for (const f of fields) {
		if (f.startsWith("UU") || f.startsWith("AA") || f.startsWith("DD"))
			failures.push(`unmerged: ${f.slice(3)}`);
	}

	// bounded re-verification via the same files gate (syntax only), in-process
	let n = 0;
	for (const rel of files) {
		if (++n > 50) {
			failures.push("(more than 50 changed files — verify the rest manually)");
			break;
		}
		const abs = `${cwd.replace(/\/$/, "")}/${rel}`;
		if (!existsSync(abs)) continue;
		const payload = {
			tool_name: "Write",
			tool_input: { file_path: abs },
			_deferred_fmt: true,
		} as HookInput;
		const v = filesCheck(payload);
		if (v.kind === "block" || v.kind === "feedback")
			failures.push((v.err ?? v.msg).trim());
	}

	if (failures.length)
		feedback(
			`STOP-GATE: not done yet — fix these before claiming completion:\n${failures.join("\n")}`,
		);

	allow();
}
