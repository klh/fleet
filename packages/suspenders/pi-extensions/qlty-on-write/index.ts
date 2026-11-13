// pi-extensions/qlty-on-write — W3059: pi's face of the fleet on-write
// qlty gate. The claude-code dialect runs gates/files.ts (PostToolUse):
// `qlty fmt` ON SAVE before the check — safe fixes land without a
// fix-it-yourself loop (owner directive 2026-09-15, "learn from the
// formatting mistakes"). pi had NO fleet on-write face (hooks/dialects/
// covers cline/codex/copilot/grok; claude-code is native; pi rode only
// the consult-plane receiver) — this extension closes that gap with the
// SAME contract:
//   - run `qlty fmt <basename>` from the file's dir (absolute paths fail
//     qlty's strip-prefix — files.ts:9)
//   - repos without qlty setup skip silently (exit 99 — files.ts:10)
//   - when bytes changed, TELL the agent to re-read (files.ts:7-8) — the
//     note rides the tool result so exact-match edits re-anchor and the
//     git diff stays the honest semantic delta (W3059 "don't confuse the
//     differ": formatting lands at write time, never at commit time).
// Self-contained: node builtins + type-only pi imports, so the installed
// copy runs anywhere (fleet-receiver pattern).
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools whose success mutates a file on disk. */
const WRITE_TOOLS = new Set(["edit", "write"]);
/** Hard cap on the fmt subprocess — a hung plugin never stalls a turn. */
const FMT_TIMEOUT_MS = 10_000;

/** The real fmt face: `qlty fmt <basename>` run from the file's dir
 *  (absolute paths fail qlty's strip-prefix — files.ts:9). Throws when
 *  qlty is absent from PATH; returns the process status (99 = no qlty
 *  setup in this repo — files.ts:10). Exported for the unit spec, which
 *  drives it against a stubbed qlty on PATH. */
export function runQltyFmt(
	dir: string,
	file: string,
	options: { timeoutMs?: number } = {},
): number {
	const r = spawnSync("qlty", ["fmt", file], {
		cwd: dir,
		stdio: "ignore",
		timeout: options.timeoutMs ?? FMT_TIMEOUT_MS,
	});
	if (r.error) throw r.error; // ENOENT etc. — silent skip
	return r.status ?? 0;
}

export interface QltyFmtOutcome {
	/** fmt ran and rewrote bytes (note-worthy). */
	changed: boolean;
	/** delta in byte length (negative = shrank). */
	delta: number;
	/** what happened, for the tool-result note. */
	note: string;
}

/** Pure core, exported for the unit spec: decide + run fmt for one path.
 *  Returns undefined when the gate silently skips (not a write tool,
 *  errored result, missing path, no qlty setup). */
export function qltyFmtOnWrite(
	toolName: string | undefined,
	input: Record<string, unknown> | undefined,
	isError: boolean | undefined,
	cwd: string,
	runFmt: (dir: string, file: string) => number, // returns exit code, mutates bytes
	sizeOf: (path: string) => number,
): QltyFmtOutcome | undefined {
	if (!toolName || !WRITE_TOOLS.has(toolName) || isError) return undefined;
	const raw = typeof input?.path === "string" ? input.path : "";
	if (!raw) return undefined;
	const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
	const dir = dirname(abs);
	const file = basename(abs);
	let before: number;
	try {
		before = sizeOf(abs);
	} catch {
		return undefined; // vanished between tool and hook — nothing to format
	}
	let code: number;
	try {
		code = runFmt(dir, file);
	} catch {
		return undefined; // qlty missing from PATH entirely — silent skip
	}
	if (code === 99) return undefined; // no qlty setup in this repo (files.ts:10)
	let after: number;
	try {
		after = sizeOf(abs);
	} catch {
		return undefined;
	}
	if (after === before) {
		return { changed: false, delta: 0, note: "" };
	}
	const delta = after - before;
	return {
		changed: true,
		delta,
		note: `[qlty-on-write] qlty fmt reformatted ${file} (${delta >= 0 ? "+" : ""}${delta} bytes) — on-disk content changed under this ${toolName}; re-read the file before further exact-match edits.`,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const outcome = qltyFmtOnWrite(
			event.toolName,
			event.input as Record<string, unknown> | undefined,
			event.isError,
			process.cwd(),
			(dir: string, file: string) => runQltyFmt(dir, file),
			(path: string) => statSync(path).size,
		);
		if (!outcome?.changed) return undefined;
		const blocks = Array.isArray(event.content) ? event.content : [];
		return {
			content: [...blocks, { type: "text", text: `\n${outcome.note}` }],
			// content patches must carry structuredContent through or it drops
			structuredContent: event.structuredContent,
		};
	});
}
