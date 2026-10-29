// board/board-knobs.ts — the ONE accessor for the board's read-path knobs,
// named by their nested settings path. Today each path reads its legacy env
// var; when the per-install settings.json (@klh/settings, one zod schema)
// lands, only boardKnob's body swaps to `setting(path)`.
//
// path                         env (today)                          default
// board.poll_memo_ms           SUSPENDERS_BOARD_POLL_MEMO_MS        1000
// board.sync_floor_ms          SUSPENDERS_BOARD_SYNC_FLOOR_MS       0
// board.sync_idle_ms           SUSPENDERS_BOARD_SYNC_IDLE_MS        30000
// board.full_reconcile_ms      SUSPENDERS_BOARD_FULL_RECONCILE_MS   300000
// board.ps_memo_ms             SUSPENDERS_BOARD_PS_MEMO_MS          2000
// board.session_recent_ms      SUSPENDERS_BOARD_SESSION_RECENT_MS   86400000
const KNOBS = {
	"board.poll_memo_ms": ["SUSPENDERS_BOARD_POLL_MEMO_MS", 1000],
	"board.sync_floor_ms": ["SUSPENDERS_BOARD_SYNC_FLOOR_MS", 0],
	"board.sync_idle_ms": ["SUSPENDERS_BOARD_SYNC_IDLE_MS", 30_000],
	"board.full_reconcile_ms": ["SUSPENDERS_BOARD_FULL_RECONCILE_MS", 300_000],
	"board.ps_memo_ms": ["SUSPENDERS_BOARD_PS_MEMO_MS", 2000],
	"board.session_recent_ms": ["SUSPENDERS_BOARD_SESSION_RECENT_MS", 86_400_000],
} as const satisfies Record<string, readonly [string, number]>;

export type BoardKnob = keyof typeof KNOBS;

/** Non-negative finite number, else the default. Read at use time. */
export function boardKnob(path: BoardKnob): number {
	const [env, fallback] = KNOBS[path];
	const raw = Number(process.env[env] ?? fallback);
	return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
