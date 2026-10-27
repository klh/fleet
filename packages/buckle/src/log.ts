// src/log.ts — W2173.7 the ONE leveled-logger seam for the fleet: a single
// module both packages ride (suspenders already imports @klh/buckle faces —
// hooks/board/routes-orch.ts precedent). Levels are filtered by
// BUCKLE_LOG_LEVEL (debug|info|warn|error, default info); the emission is
// one line per event: `<prefix> <LEVEL> <message>`. warn/error ride stderr,
// debug/info stdout — a boot log and a failure log must never share a pipe.
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Ascending severity — filter is `at or above the configured level`. */
export const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
	if (level === "warn" || level === "error") console.error(line);
	else console.log(line);
};

/** Resolve the threshold from env; unknown/absent values keep the default. */
export function resolveLogLevel(
	env: Record<string, string | undefined> = process.env,
	defaultLevel: LogLevel = "info",
): LogLevel {
	const raw = env.BUCKLE_LOG_LEVEL ?? "";
	return raw in LEVEL_ORDER ? (raw as LogLevel) : defaultLevel;
}

export interface Logger {
	readonly level: LogLevel;
	debug(msg: string): void;
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

/** Bind one scoped logger: `buckle:<scope> <LEVEL> <msg>` per emission. */
export function createLogger(
	scope: string,
	opts: { level?: LogLevel; sink?: LogSink } = {},
): Logger {
	const level = opts.level ?? resolveLogLevel();
	const sink = opts.sink ?? defaultSink;
	const prefix = `buckle:${scope}`;
	const emit = (msgLevel: LogLevel, msg: string): void => {
		if (LEVEL_ORDER[msgLevel] < LEVEL_ORDER[level]) return;
		sink(msgLevel, `${prefix} ${msgLevel} ${msg}`);
	};
	return {
		level,
		debug: (msg) => emit("debug", msg),
		info: (msg) => emit("info", msg),
		warn: (msg) => emit("warn", msg),
		error: (msg) => emit("error", msg),
	};
}
