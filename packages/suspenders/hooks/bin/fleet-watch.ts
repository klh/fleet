// hooks/bin/fleet-watch.ts — W522: resident fleet sidebar TUI. ALL lanes +
// tasks + claims, live, in one bounded terminal pane (tmux split, iTerm2
// pane, or a bare terminal). Inputs are the sanctioned read faces: `coord
// fleet --json` (lane states/names), `work lanes --json` (.fleet registry
// liveness), board GET /api/tasks (tasks + .prefer tag colors). 1s tick,
// diff-rendered ANSI (only changed lines rewritten — no full-clear flicker),
// width clamped to 40–60 cols, zero deps. `--once` renders one frame and
// exits (pipes, cron, smoke tests).
// Usage: bun fleet-watch.ts [--interval ms] [--width n] [--height n]
//                          [--top n] [--board url] [--once]
import {
	collectBoardTasks,
	collectCoordFleet,
	collectWorkLanes,
	fleetRootLabel,
	mergeLanes,
} from "../lib/watch/sources.ts";
import { buildFrame, emitFrame } from "../lib/watch/frame.ts";
import type { BoardTaskRow } from "../lib/watch/frame.ts";

interface Opts {
	interval: number;
	width: number;
	height: number;
	top: number;
	board: string;
	once: boolean;
}
const num = (v: string | undefined, dflt: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
};

function parseArgs(argv: string[]): Opts {
	const o: Opts = {
		interval: 1000,
		width: 48,
		height: 30,
		top: 10,
		board: process.env.FLEET_WATCH_BOARD ?? "http://127.0.0.1:7799",
		once: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const v = argv[i + 1];
		if (a === "--once") o.once = true;
		else if (a === "--interval") {
			o.interval = Math.max(250, num(v, 1000));
			i++;
		} else if (a === "--width") {
			// mission law: bounded sidebar width 40–60 cols
			o.width = Math.min(60, Math.max(40, num(v, 48)));
			i++;
		} else if (a === "--height") {
			o.height = Math.max(8, num(v, 30));
			i++;
		} else if (a === "--top") {
			o.top = Math.max(3, num(v, 10));
			i++;
		} else if (a === "--board") {
			o.board = v ?? o.board;
			i++;
		} else {
			process.stderr.write(
				`fleet-watch: unknown arg ${a}\nusage: fleet-watch [--interval ms] [--width 40-60] [--height n] [--top n] [--board url] [--once]\n`,
			);
			process.exit(2);
		}
	}
	return o;
}

async function tick(o: Opts, prev: string[] | null): Promise<string[]> {
	const t0 = Date.now();
	const [coord, workLanes, board] = await Promise.all([
		Promise.resolve(collectCoordFleet()),
		Promise.resolve(collectWorkLanes()),
		collectBoardTasks(o.board),
	]);
	const tasks = (board?.tasks ?? []).map((t) => ({
		id: String(t.id),
		title: String(t.title ?? ""),
		state: String(t.state ?? ""),
		owner_sid: t.owner_sid ? String(t.owner_sid) : null,
		owner_label: t.owner_label ?? null,
		age_s: Number(t.age_s ?? 0),
		tag_color: t.tag_color ?? null,
	}));
	const lines = buildFrame({
		head: coord?.head ?? null,
		lanes: mergeLanes(coord, workLanes, tasks),
		tasks: tasks as BoardTaskRow[],
		totalTasks: tasks.length,
		boardOk: board !== null,
		boardMs: board?.ms ?? 0,
		now: t0,
		width: o.width,
		height: o.height,
		top: o.top,
		fleetRoot: fleetRootLabel(),
	});
	const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
	emitFrame(prev, lines, tty, (s) => process.stdout.write(s));
	return lines;
}

const o = parseArgs(process.argv.slice(2));
const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
if (tty && !o.once) process.stdout.write("\x1b[?25l"); // hide cursor
let prev: string[] | null = null;
let running = false;
let stopping = false;
const stop = (): void => {
	stopping = true;
	if (tty) process.stdout.write("\x1b[?25h\n"); // cursor back, clean line
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

while (!stopping) {
	if (!running) {
		running = true;
		prev = await tick(o, prev)
			.catch((e) => {
				console.error(`fleet-watch tick failed: ${String(e)}`);
				return prev;
			})
			.finally(() => {
				running = false;
			});
	}
	if (o.once) break;
	await Bun.sleep(o.interval);
}
