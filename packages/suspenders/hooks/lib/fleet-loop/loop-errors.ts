// fleet-loop/loop-errors.ts — W2173.7 the loop's ONE typed-error kit: a
// CLI loop has no HTTP face, so it does not ride buckle's HttpProblem; it
// carries the equivalent grammar — kind (the code enum), stable
// `loop.<slug>` codes, honest message. loopDie renders `<code>: <why>` on
// stderr and exits; describeError renders any thrown value as one line.
export type LoopErrorCode =
	| "loop.usage"
	| "loop.config_invalid"
	| "loop.hold_enforcement_failed"
	| "loop.watchdog_kill_failed"
	| "loop.ship_missing_branch"
	| "loop.ship_veto"
	| "loop.ship_branch_missing";

export class LoopError extends Error {
	readonly code: LoopErrorCode;
	constructor(code: LoopErrorCode, message: string) {
		super(message);
		this.name = "LoopError";
		this.code = code;
	}
}

/** The uniform CLI death: stable code on stderr, exit 1 (or exitCode). */
export const loopDie = (
	code: LoopErrorCode,
	why: string,
	exitCode = 1,
): never => {
	console.error(`${code}: ${why}`);
	process.exit(exitCode);
};

/** One-line render of any thrown value; LoopError carries its code. */
export const describeError = (e: unknown): string =>
	e instanceof LoopError
		? `${e.code}: ${e.message}`
		: e instanceof Error
			? e.message
			: String(e);
