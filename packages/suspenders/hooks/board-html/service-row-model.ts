// hooks/board-html/service-row-model.ts — W273: the DOM-free half of
// <klh-service-row>. What a row shows for a probe result and the re-probe
// round-trip live here so tests drive them with stub probe results; the
// Lit component only renders this model.
import type { RecoveryEntry } from "../lib/recovery-map.ts";
import { observationFresh, type Observation } from "../lib/observation.ts";

export type RowState = "up" | "degraded" | "down" | "idle";

export interface RowProbe {
	id: string;
	name: string;
	port: number;
	up: boolean;
	state: RowState;
	detail: string;
	probed_at: string;
	observation?: Observation;
	recovery: RecoveryEntry | null;
}

export interface RowModel {
	badge: "UP" | "DEGRADED" | "DOWN" | "IDLE" | "STALE";
	tone: "ok" | "warn" | "bad" | "dim";
	where: string;
	showRecovery: boolean;
	// open by default when dark: the user came here because it's broken
	open: boolean;
	saw: string;
	what: string;
	causes: string[];
	steps: { label: string; cmd: string }[];
}

const stateOf = (p: RowProbe): RowState => p.state ?? (p.up ? "up" : "down");

export const rowModel = (p: RowProbe, now = Date.now()): RowModel => {
	const state = stateOf(p);
	const stale = !!p.observation && !observationFresh(p.observation, now);
	const r = p.recovery;
	const showRecovery =
		!stale && state !== "up" && state !== "idle" && r !== null;
	return {
		badge: stale
			? "STALE"
			: state === "idle"
				? "IDLE"
				: state === "up"
					? "UP"
					: state === "degraded"
						? "DEGRADED"
						: "DOWN",
		tone: stale
			? "dim"
			: state === "idle"
				? "dim"
				: state === "up"
					? "ok"
					: state === "degraded"
						? "warn"
						: "bad",
		where:
			r?.probe.kind === "launchd"
				? "launchd"
				: r?.probe.kind === "http"
					? `:${r.probe.port}${r.probe.path}`
					: `:${p.port}`,
		showRecovery,
		open: !stale && state === "down",
		saw: stale
			? `Last known ${state}: ${p.detail}. Current state unknown.`
			: p.detail,
		what: r?.what ?? "",
		causes: showRecovery && r ? r.causes : [],
		steps: showRecovery && r ? r.recovery : [],
	};
};

type FetchLike = (url: string) => Promise<Response>;

// the re-probe round-trip: GET /api/services/probe?id=… → the fresh row.
// Never throws; a failed round-trip keeps the last known probe + an error.
export class ServiceRowController {
	probe: RowProbe;
	busy = false;
	err: string | null = null;

	constructor(probe: RowProbe) {
		this.probe = probe;
	}

	async reprobe(fetchFn: FetchLike): Promise<RowProbe> {
		if (this.busy) return this.probe;
		this.busy = true;
		this.err = null;
		try {
			const r = await fetchFn(
				`/api/services/probe?id=${encodeURIComponent(this.probe.id)}`,
			);
			const d = (await r.json()) as {
				ok?: boolean;
				service?: RowProbe;
				error?: string;
			};
			if (!r.ok || !d.ok || !d.service)
				throw new Error(d.error ?? `HTTP ${r.status}`);
			this.probe = d.service;
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
		return this.probe;
	}
}
