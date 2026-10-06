import { readFileSync } from "node:fs";

/** Read persisted external probes without importing belt's runtime modules. */
export const readSupervisorSnapshot = (): unknown => {
	try {
		const file =
			process.env.BELT_SUPERVISOR_STATUS ??
			`${process.env.HOME}/.claude-insights/belt-supervisor.json`;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

/** Missing models are idle only when recent independent probes say so. */
export const isOnDemandIdle = (
	snapshot: unknown,
	port: number,
	now: number,
): boolean => {
	const doc = record(snapshot);
	if (
		doc?.version !== 1 ||
		!Array.isArray(doc.targets) ||
		typeof doc.intervalMs !== "number" ||
		!Number.isFinite(doc.intervalMs) ||
		doc.intervalMs <= 0
	)
		return false;
	const limit = Math.max(15_000, doc.intervalMs * 3);
	const fresh = (value: unknown): boolean => {
		if (typeof value !== "string") return false;
		const time = Date.parse(value);
		return Number.isFinite(time) && time <= now + 5_000 && now - time <= limit;
	};
	if (!fresh(doc.updated)) return false;
	return doc.targets.some((value) => {
		const target = record(value);
		return (
			target?.port === port &&
			target.kind === "ondemand" &&
			target.state === "idle" &&
			target.alert === false &&
			!target.preflightError &&
			fresh(target.lastProbe)
		);
	});
};
