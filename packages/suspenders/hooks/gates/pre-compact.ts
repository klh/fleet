// hooks/gates/pre-compact.ts — W510: PreCompact claim-state flush. Compaction
// is a lossy summarizer; anything not on disk before it fires is gone. When
// this session is a lane (lane-context resolves), bank the deterministic
// in-flight state — claim id, branch head, dirty files — into the lane's
// coord capsule (the SAME surface the re-dispatch RESUME PATH reads) via the
// supported CLI verb. No lane context → silent no-op (interactive sessions
// hold no claim). Never blocks: compaction proceeds regardless.
import { join, resolve } from "node:path";
import { allow, type HookInput } from "../lib/hookio.ts";
import { laneContext } from "../lib/lane-context.ts";
import { run } from "../lib/run.ts";

export function preCompactGate(hook: HookInput): never {
	const ctx = hook.cwd ? laneContext(hook.cwd) : undefined;
	if (ctx?.sid && ctx.item) {
		const dirty = run("git", ["status", "--porcelain=v1", "-z"], {
			cwd: hook.cwd,
		});
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
			: [];
		const head = run("git", ["rev-parse", "HEAD"], { cwd: hook.cwd });
		const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: hook.cwd,
		});
		const bin = resolve(import.meta.dir, "../bin");
		run(
			process.execPath,
			[
				join(bin, "coord.ts"),
				"capsule",
				"set",
				"--as",
				ctx.sid,
				`--checkpoint=${head.ok ? head.out.trim() : "none"}`,
				`--item=${ctx.item}`,
				`--branch=${branch.ok ? branch.out.trim() : ""}`,
				`--files=${files.join(",")}`,
				"--note=pre-compact auto-bank",
			],
			{ cwd: hook.cwd },
		);
	}
	allow();
}
