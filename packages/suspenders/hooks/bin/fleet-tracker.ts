// bin/fleet-tracker.ts — W575: Polyend-Tracker-style terminal sidecar for
// live fleet lanes. Read-only by construction: every statement it runs is a
// SELECT over the canonical surfaces (work_items, claims, sessions, facts,
// events, work_completion_records) through the same store port the coord CLI
// uses — no ownership mutations, no second ledger, no CLI-display parsing.
// Lanes are columns, chronological transitions flow top→bottom, cells are
// `ID<symbol>` with one glyph per state (colour is additive, never the only
// signal). Runs in any terminal split alongside any harness CLI.
//
// usage: bun ~/.claude/bin/fleet-tracker.ts [--project p] [--history N]
//        [--poll-ms N] [--once] [--no-color] [--help]
import { openStore } from "../lib/govdb.ts";
import { TrackerFeed } from "../tracker/feed.ts";
import { renderFrame } from "../tracker/render.ts";
import { type Detail, itemDetail, takeSnapshot } from "../tracker/snapshot.ts";

const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => argv.includes(name);

if (has("--help")) {
	console.log(`fleet-tracker — read-only terminal sidecar for live fleet lanes

  lanes are columns; transitions flow top→bottom; cells show work-item ids
  and one non-colour glyph per state:
    · queued   ◇ claimed   ▶ running   ? decision
    ✓ complete ✗ failed    ! stalled   ~ unknown

usage: bun fleet-tracker.ts [--project p] [--history N] [--poll-ms N] [--once] [--no-color]

  --project p   filter to one project's items (default: every project)
  --history N   bounded timeline rows kept in memory (default 400)
  --poll-ms N   liveness/lease refresh tick (default 5000)
  --once        render one frame and exit (no TUI, pipe-safe)
  --no-color    plain text output
  read-only: the tracker never mutates fleet state; quit with q or ctrl-c`);
	process.exit(0);
}

const project = argOf("--project");
const history = Math.max(1, Number(argOf("--history") ?? 400) || 400);
const pollMs = Math.max(1000, Number(argOf("--poll-ms") ?? 5000) || 5000);
const once = has("--once");
const useColor =
	!has("--no-color") && process.stdout.isTTY && !process.env.NO_COLOR;
// piped frames get a wide canvas — the TUI follows the real terminal
const defaultWidth = once ? 240 : 100;

const db = openStore();

function currentFrame(
	selRow: number,
	selCol: number,
	detail: Detail | null,
): string {
	const snap = takeSnapshot(db, project, history);
	snap.transitions = once ? snap.transitions : feed.ring.rows();
	return renderFrame(snap, {
		width: process.stdout.columns ?? defaultWidth,
		height: process.stdout.rows ?? 30,
		useColor,
		selRow,
		selCol,
		detail,
	});
}

const feed = new TrackerFeed(db, {
	project,
	history,
	reconcileMs: Math.max(pollMs, 30_000),
});

if (once) {
	console.log(currentFrame(0, 0, null));
	feed.stop();
	process.exit(0);
}

// —— live TUI ————————————————————————————————————————————————
const ALTERNATE = "\x1b[?1049h";
const RESTORE = "\x1b[?1049l\x1b[?25h";
let selRow = 0;
let selCol = 0;
let maxCol = 0;
let detail: Detail | null = null;
let dirty = true;

function draw(): void {
	dirty = false;
	const snap = takeSnapshot(db, project, history);
	snap.transitions = feed.ring.rows();
	maxCol = snap.columns.length;
	const frame = renderFrame(snap, {
		width: process.stdout.columns ?? defaultWidth,
		height: process.stdout.rows ?? 30,
		useColor,
		selRow,
		selCol,
		detail,
	});
	process.stdout.write(`${ALTERNATE}\x1b[H\x1b[J${frame}\n`);
}

function selectedTransition() {
	const rows = feed.ring.rows();
	const idx = rows.length - 1 - selRow;
	return idx >= 0 ? (rows[idx] ?? null) : null;
}

function restore(): void {
	process.stdout.write(RESTORE);
	try {
		(
			process.stdin as unknown as { setRawMode?: (b: boolean) => void }
		).setRawMode?.(false);
	} catch {}
	process.exit(0);
}

process.on("SIGINT", restore);
process.stdout.on("resize", () => {
	dirty = true;
});

const stdin = process.stdin as unknown as {
	setRawMode?: (b: boolean) => void;
	setEncoding: (e: string) => void;
	on: (ev: string, fn: (chunk: string) => void) => void;
	resume: () => void;
	pause: () => void;
};
stdin.setEncoding("utf8");
stdin.setRawMode?.(true);
stdin.on("data", (chunk: string): void => {
	// manual tokenizer: raw-mode chunks arrive as whole escape sequences;
	// a regex here would need literal control characters (biome-banned)
	const tokens: string[] = [];
	for (let i = 0; i < chunk.length; i++) {
		const c0 = chunk[i];
		if (c0 === "\x1b" && (chunk[i + 1] === "[" || chunk[i + 1] === "O")) {
			const c2 = chunk[i + 2];
			if (c2 === "A" || c2 === "B" || c2 === "C" || c2 === "D") {
				tokens.push(c0 + chunk[i + 1] + c2);
				i += 2;
				continue;
			}
		}
		tokens.push(c0);
	}
	for (const key of tokens) {
		if (key === "q" || key === "\x03") {
			feed.stop();
			restore();
			continue;
		}
		if (key === "r") {
			feed.reconcile();
			dirty = true;
			continue;
		}
		if (key === "\x1b[A" || key === "\x1bOA" || key === "k") {
			selRow = Math.min(selRow + 1, Math.max(0, feed.ring.size - 1));
			dirty = true;
			continue;
		}
		if (key === "\x1b[B" || key === "\x1bOB" || key === "j") {
			selRow = Math.max(0, selRow - 1);
			dirty = true;
			continue;
		}
		if (key === "\x1b[D" || key === "\x1bOD" || key === "h") {
			selCol = Math.max(0, selCol - 1);
			dirty = true;
			continue;
		}
		if (key === "\x1b[C" || key === "\x1bOC" || key === "l") {
			selCol = Math.min(selCol + 1, maxCol);
			dirty = true;
			continue;
		}
		if (key === "\r" || key === "\n") {
			const t = selectedTransition();
			detail = t?.item != null ? itemDetail(db, t.project ?? "", t.item) : null;
			dirty = true;
			continue;
		}
		if (key === "\x1b") {
			detail = null;
			dirty = true;
		}
	}
});

feed.start();
process.stdout.write(ALTERNATE);
draw();
const ticker = setInterval(() => {
	dirty = true;
}, pollMs);
const drawer = setInterval(() => {
	if (dirty) draw();
}, 100);
process.on("exit", () => {
	clearInterval(ticker);
	clearInterval(drawer);
});
