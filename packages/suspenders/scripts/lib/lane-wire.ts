// W1712: executor ↔ model wire compatibility at dispatch. An executor CLI
// speaks one request wire (ExecutorAdapter.wire); a pinned model is served on
// the endpoint union the canonical capability registry records for its Buckle
// group (belt model-capabilities.ts `endpoints`, joined per group by W1711's
// groupWireEndpoints — never inferred from upstreams config). Buckle bridges
// messages ↔ chat both ways (W426) but forwards /v1/responses verbatim
// (W912): a Responses-only model is never re-targeted at chat. Unknown (null)
// never refuses and never re-selects.

import {
	defaultCapabilitySnapshotPath,
	groupWireEndpoints,
	readCapabilitySnapshot,
} from "@klh/belt/bin/model-capabilities.ts";
import {
	adapterForExact,
	EXECUTOR_ADAPTERS,
} from "../../hooks/lib/executors/registry.ts";
import type { LaneWire } from "../../hooks/lib/lanes/lane.ts";
import {
	type StackConfig,
	tryLoadStack,
} from "../../hooks/lib/stack-config.ts";

export const WIRE_PATH: Record<LaneWire, string> = {
	messages: "/v1/messages",
	chat: "/v1/chat/completions",
	responses: "/v1/responses",
};

/** The endpoints a client wire lands on through Buckle. */
const LANDS_ON: Record<LaneWire, readonly string[]> = {
	messages: [WIRE_PATH.messages, WIRE_PATH.chat],
	chat: [WIRE_PATH.chat, WIRE_PATH.messages],
	responses: [WIRE_PATH.responses],
};

/** true/false = the known endpoint union does/doesn't answer `wire`;
 *  null = unknown. */
export const servesWire = (
	endpoints: readonly string[] | null,
	wire: LaneWire,
): boolean | null =>
	endpoints ? LANDS_ON[wire].some((p) => endpoints.includes(p)) : null;

/** A pinned model's known endpoint union; null = unknown (any row unknown). */
export type GroupEndpoints = (
	model: string,
) => Promise<readonly string[] | null>;

/** Production source until W1711's registry join lands: always unknown. */
export const unknownEndpoints: GroupEndpoints = async () => null;

/** W1729: freshness window for capability records at dispatch time — a
 *  record older than this reads unknown (never refuses, never re-selects). */
export const WIRE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** W1729: the production join. The stack's upstreams groups supply row
 *  IDENTITY only (url + exact provider model id); the endpoint facts come
 *  from the canonical capability snapshot (belt defaultCapabilitySnapshotPath)
 *  via W1711's groupWireEndpoints — never inferred from config. An absent
 *  group, an unknown row or an unreadable snapshot reads unknown. */
export const stackWireEndpoints =
	(
		stack: StackConfig | null = tryLoadStack(),
		snapshotPath: string = defaultCapabilitySnapshotPath(),
	): GroupEndpoints =>
	async (group) => {
		const rows = Object.values(stack?.hubs ?? {}).flatMap(
			(hub) =>
				(hub.upstreams?.groups?.[group] ?? []) as Array<
					Record<string, unknown>
				>,
		);
		if (!rows.length) return null;
		const { registry } = await readCapabilitySnapshot(snapshotPath);
		return groupWireEndpoints(rows, registry, WIRE_SNAPSHOT_MAX_AGE_MS);
	};

export type WirePick =
	| { ok: true; bin: string; switched: boolean }
	| { ok: false; why: string };

/** Keep the picked executor unless its wire is provably unserved. A
 *  defaulted carrier (`reselect`: a steady-chain model pin riding the default
 *  CLI) yields to the first spawnable adapter whose wire is provably served —
 *  the SAME model rides it. An explicit executor+model pairing, or no
 *  provable carrier, refuses. */
export const wirePick = async (
	pick: { bin: string; model: string | null },
	endpointsOf: GroupEndpoints,
	reselect: boolean,
): Promise<WirePick> => {
	const keep: WirePick = { ok: true, bin: pick.bin, switched: false };
	const wire = adapterForExact(pick.bin)?.wire;
	if (!wire || !pick.model) return keep;
	const endpoints = await endpointsOf(pick.model);
	if (servesWire(endpoints, wire) !== false) return keep;
	const carrier = reselect
		? EXECUTOR_ADAPTERS.find(
				(a) => a.spawnable && a.wire && servesWire(endpoints, a.wire),
			)
		: undefined;
	if (carrier) return { ok: true, bin: carrier.bin, switched: true };
	return {
		ok: false,
		why: `${pick.bin} speaks ${WIRE_PATH[wire]} but ${pick.model} serves ${endpoints?.join(", ") || "no known endpoint"} — pin ${pick.model} on an executor that speaks its wire`,
	};
};
