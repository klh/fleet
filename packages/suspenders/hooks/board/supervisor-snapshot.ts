import { readFileSync } from "node:fs";
import {
	observation,
	observationFresh,
	type Observation,
} from "../lib/observation.ts";

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
export const onDemandIdleObservation = (
	snapshot: unknown,
	port: number,
	now: number,
): Observation | null => {
	const doc = record(snapshot);
	if (
		doc?.version !== 1 ||
		!Array.isArray(doc.targets) ||
		typeof doc.intervalMs !== "number" ||
		!Number.isFinite(doc.intervalMs) ||
		doc.intervalMs <= 0
	)
		return null;
	const limit = Math.max(15_000, doc.intervalMs * 3);
	const fresh = (value: unknown): boolean => {
		if (typeof value !== "string") return false;
		const time = Date.parse(value);
		return Number.isFinite(time) && time <= now + 5_000 && now - time <= limit;
	};
	if (!fresh(doc.updated)) return null;
	const value = doc.targets.find((value) => {
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
	const target = record(value);
	if (!target) return null;
	const updatedAt = Date.parse(String(doc.updated));
	const lastProbeAt = Date.parse(String(target.lastProbe));
	const observedAt = Math.min(updatedAt, lastProbeAt);
	const expiresAt = Math.min(updatedAt + limit, lastProbeAt + limit);
	const evidence = observation(
		"belt-supervisor",
		`supervisor-target:${port}`,
		"local-machine",
		observedAt,
		expiresAt - observedAt,
		"supervisor",
	);
	return observationFresh(evidence, now) ? evidence : null;
};

export const isOnDemandIdle = (
	snapshot: unknown,
	port: number,
	now: number,
): boolean => onDemandIdleObservation(snapshot, port, now) !== null;
