// src/app-deps.ts — AppDeps: the wire handlers' dependency contract
// (W1297 split out of handlers.ts; the interface body is byte-identical).

import type { RpcAdmission } from "./admission.ts";
import type { PrefixAffinity } from "./affinity.ts";
import type { AidsLedger } from "./aids.ts";
import type { AccountPolicyDoc } from "./account-policy.ts";
import type { LaneTelemetryLog } from "./cache-boundary.ts";
import type { PrefixLedger } from "./cache-fingerprint.ts";
import type { CandidateTable } from "./candidates.ts";
import type { DecideResult } from "./decide.ts";
import type { DietStore } from "./diet.ts";
import type { Expander } from "./expand.ts";
import type { Federation } from "./gov/federation.ts";
import type { RouteHint } from "./hints.ts";
import type { Ledger } from "./ledger.ts";
import type { Preseeder } from "./preseed.ts";
import type { AidsPolicy } from "./policy.ts";
import type { CondenseStore } from "./pipeline.ts";
import type { RepoPolicyRow } from "./repo-policy.ts";
import type { Router } from "./router.ts";
import type { Servicemon } from "./servicemon.ts";
import type { ObservationOutbox } from "./observe.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";

export interface AppDeps {
	router: Router;
	ledger: Ledger;
	sm: Servicemon;
	pool: UpstreamPool;
	// W140: the pure decision over the candidate table + the table itself
	// (EWMA outcomes, in-flight load)
	decide: (input: {
		group: string;
		dialect: Dialect;
		hint: RouteHint | null;
		hintRaw: string;
		allowCross: boolean;
		/** W1265: scope the candidate set to this catalog provider
		 *  (dep.adapter) only — a pinned route never substitutes. */
		providerPin?: string;
	}) => DecideResult;
	table: CandidateTable;
	// W142 knowledge aids: the metering ledger, the preseed builder, and the
	// policy slice that gates them (routing-policy.yaml `aids:` block)
	aids: AidsLedger;
	preseeder: Preseeder;
	aidsPolicy: AidsPolicy;
	// W4 intent expansion — optional so bare deps (testDeps, dev) skip the
	// expand aid honestly instead of failing the wire path.
	expander?: Expander;
	// W5 prompt pipeline IN: the condense sidestore (pipeline.ts). Optional —
	// bare deps (testDeps, dev) skip honestly and the routes 404 (AppDeps law).
	pipeline?: CondenseStore;
	// W207 trajectory pruning: the diet sidestore (diet.ts). Optional — bare
	// deps (testDeps, dev) skip honestly and the routes 404 (AppDeps law).
	diet?: DietStore;
	// W154 federation surface — present on hub-shaped deps (buildDeps);
	// optional so bare deps (testDeps, dev) 404 honestly.
	federation?: Federation;
	// W7 repo-policy gate: the loaded rows (absent/empty = engine inert);
	// the route 404s honestly when unwired.
	repoPolicy?: RepoPolicyRow[];
	// W1265.1 account policy: the loaded repo-tier class table (null = the
	// boundary is inert — no policy configured; gate-off + active policy is
	// still fail-closed in proxy()). Optional — bare deps (testDeps, dev).
	accountPolicy?: AccountPolicyDoc | null;
	// W237 prefix-affinity: the prefix → candidate memo. Optional — bare
	// deps (testDeps, dev) route without affinity and the seam no-ops.
	affinity?: PrefixAffinity;
	// W458.4 per-lane cache telemetry: the append-only NDJSON lane log.
	// Optional — bare deps (testDeps, dev) skip lane rows honestly.
	laneCache?: LaneTelemetryLog;
	// W926 miss classification: per-boundary+lane prefix-fingerprint
	// references. Optional — unwired rows carry null prefix_fp/null
	// miss_cause (unknown, never guessed).
	prefixLedger?: PrefixLedger;
	// W450 bounded RPC admission: in-flight slot bound over the proxy path.
	// Optional — bare deps (testDeps, dev) admit unbounded (current shape).
	admission?: RpcAdmission;
	/** Injection seam for the 120s ingress body deadline. */
	ingressBodyTimeoutMs?: number;
	// W461 stage 2: the bounded observation outbox. Optional — absent =
	// observations inert (bare deps, or BUCKLE_OBSERVATIONS_PATH unset).
	observations?: ObservationOutbox;
	// W706: this hub's stable id (BUCKLE_HUB_ID) — the peer/origin identity
	// stamped on relay legs + observations. Absent → "local".
	hubId?: string;
}
