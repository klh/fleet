// hooks/gates/precompact.ts — W642 PreCompact claim-state flush (research
// oh-my-claude L3 / oh-my-claudecode §1.4): compaction is a lossy summarizer;
// anything not on disk before it fires is gone. One deterministic file per
// lane — .fleet/state-<sid>.md — carrying claim, git progress and the item
// capsule (done/next). SessionStart re-injects it when source=compact.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { allow, context, type HookInput } from "../lib/hookio.ts";
import { run } from "../lib/run.ts";
import { capsuleEvidence } from "../lib/lane-completion.ts";
import { laneContext } from "../lib/lane-context.ts";
import { projectIdentity } from "../lib/govdb-project.ts";
import { resolveTranscriptPath, transcriptTail } from "../lib/transcript.ts";
import { join, resolve } from "node:path";

const BIN = join(resolve(import.meta.dir, ".."), "bin");

/** The user's own words from the transcript tail — the directives most
 * likely to be lost by the summarizer. Capped, text-only, no tool results. */
function recentDirectives(transcript: string | null): string[] {
	if (!transcript) return [];
	const lines = transcriptTail(transcript, 65_536).split("\n");
	const found: string[] = [];
	for (const line of lines.reverse()) {
		if (found.length >= 5) break;
		let msg: {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		const content = msg.message?.content;
		if (msg.message?.role !== "user" || typeof content !== "string") continue;
		// interrupt markers are harness chatter, not directives
		if (/\[Request interrupted/.test(content)) continue;
		found.push(content.slice(0, 160));
	}
	return found;
}

/** W510: PreCompact capsule bank — when this session is a lane, refresh the
 * lane's coord capsule (the SAME surface the re-dispatch RESUME PATH reads)
 * with the in-flight state: current head, branch, dirty files. done/next are
 * PRESERVED from the existing item-key capsule (banking replaces the whole
 * payload; a flush must never erase a hand-banked hand-off). No lane context
 * → silent no-op; any probe failure degrades — compaction proceeds. */
export function bankCapsule(hook: HookInput): void {
	const cwd = hook.cwd;
	if (!cwd) return;
	const ctx = laneContext(cwd);
	if (!ctx?.sid || !ctx.item) return;
	const coord = join(resolve(import.meta.dir, ".."), "bin", "coord.ts");
	const git = (...a: string[]) => run("git", a, { cwd });
	const head = git("rev-parse", "HEAD");
	const dirty = git("status", "--porcelain=v1", "-z");
	const files = dirty.ok
		? dirty.out
				.split("\0")
				.filter(Boolean)
				.map((f) => {
					const p = f.slice(3);
					const arrow = p.indexOf(" -> ");
					return arrow === -1 ? p : p.slice(arrow + 4);
				})
				.filter((p) => p && !p.includes(".claude/"))
				.slice(0, 10)
				.join(",")
		: "";
	const prev = (() => {
		const g = run(
			process.execPath,
			[coord, "capsule", "get", "--as", ctx.sid, "--item", ctx.item],
			{ cwd },
		);
		try {
			return g.ok
				? (JSON.parse(g.out.trim()) as { done?: unknown; next?: unknown })
				: null;
		} catch {
			return null;
		}
	})();
	run(
		process.execPath,
		[
			coord,
			"capsule",
			"set",
			"--as",
			ctx.sid,
			"--item",
			ctx.item,
			`--checkpoint=${head.ok ? head.out.trim() : "none"}`,
			`--branch=${git("rev-parse", "--abbrev-ref", "HEAD").out.trim()}`,
			`--files=${files}`,
			"--note=pre-compact auto-bank",
			`--done=${typeof prev?.done === "string" ? prev.done : "(none banked pre-compact)"}`,
			`--next=${typeof prev?.next === "string" ? prev.next : `resume: bun work show ${ctx.item}`}`,
		],
		{ cwd },
	);
}

export function preCompactGate(hook: HookInput): never {
	const cwd = hook.cwd ?? "";
	if (!cwd || !existsSync(cwd)) allow();
	bankCapsule(hook); // W510: refresh the lane capsule before the summarizer
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) allow();
	const wt = top.out.trim();
	const lane = laneContext(wt);
	const sid = lane?.sid ?? hook.session_id ?? "unknown";
	const cap = lane
		? capsuleEvidence(lane.item, sid, projectIdentity(wt))
		: null;
	const branch = run("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
	const head = run("git", ["-C", wt, "rev-parse", "--short=8", "HEAD"]);
	const log = run("git", ["-C", wt, "log", "--oneline", "-5"]);
	const status = run("git", ["status", "--porcelain=v1"], { cwd: wt });

	const claimLine = lane
		? (() => {
				const show = run(
					process.execPath,
					[join(BIN, "work.ts"), "show", lane.item, "--json"],
					{ cwd: wt },
				);
				if (!show.ok) return `${lane.item} [unverifiable state]`;
				try {
					const row = JSON.parse(show.out) as {
						id?: string;
						state?: string;
						title?: string;
					};
					return `${row.id ?? lane.item} [${row.state ?? "?"}] ${row.title ?? ""}`;
				} catch {
					return `${lane.item} [unverifiable state]`;
				}
			})()
		: "none — no lane context in this worktree";

	const statusLines = status.ok
		? status.out.split("\n").filter(Boolean).slice(0, 10)
		: [];
	const directives = recentDirectives(resolveTranscriptPath(hook));
	const done = typeof cap?.done === "string" ? cap.done : null;
	const next = typeof cap?.next === "string" ? cap.next : null;
	const fileBody = [
		`# lane state — ${sid}`,
		`written: ${new Date().toISOString()} (W642 PreCompact flush; SessionStart re-injects on compact)`,
		"",
		"## claim",
		`- item: ${claimLine}`,
		`- owner: ${sid}`,
		`- resume: bun ${BIN}/work.ts show ${lane?.item ?? "<item>"}`,
		"",
		"## progress (git)",
		`- branch: ${branch.ok ? branch.out.trim() : "?"} @ ${head.ok ? head.out.trim() : "?"}`,
		"- recent:",
		log.ok
			? log.out
					.trim()
					.split("\n")
					.map((l) => `  ${l}`)
			: ["  (unavailable)"],
		`- dirty (cap 10): ${statusLines.length ? "" : "(clean)"}`,
		...statusLines.map((l) => `  ${l}`),
		"",
		"## capsule (item graph)",
		`- checkpoint: ${typeof cap?.checkpoint === "string" ? cap.checkpoint : "none"}`,
		`- done: ${done ?? "(none banked)"}`,
		`- next: ${next ?? "(none banked)"}`,
		"",
		"## recent directives (transcript tail, cap 5)",
		directives.length ? directives.map((d) => `- ${d}`) : ["- (none readable)"],
		"",
	].join("\n");

	mkdirSync(join(wt, ".fleet"), { recursive: true });
	const file = join(wt, `.fleet/state-${sid}.md`);
	writeFileSync(file, fileBody);
	context(
		`PRECOMPACT FLUSH: lane state for ${sid} → .fleet/state-${sid}.md — claim: ${claimLine}; ` +
			`branch ${branch.ok ? branch.out.trim() : "?"}; capsule done/next ${done ? "banked" : "not banked"}. ` +
			"SessionStart re-injects it after compaction.",
		"PreCompact",
	);
}
