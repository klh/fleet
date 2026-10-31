// test/deps.ts — full AppDeps over a mock pool: candidate table + pure
// decide + router sharing one Cooldowns instance (the W140 seam,
// server-shaped). e2e tests build deps through here.

import type { AccountPolicyDoc } from "../src/account-policy.ts";
import { AidsLedger } from "../src/aids.ts";
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { decideRoute } from "../src/decide.ts";
import type { AppDeps } from "../src/handlers.ts";
import type { RouteHint } from "../src/hints.ts";
import { Ledger } from "../src/ledger.ts";
import type { GatewayPolicy, Prefs } from "../src/policy.ts";
import { Preseeder } from "../src/preseed.ts";
import { Router } from "../src/router.ts";
import { servicemon } from "../src/servicemon.ts";
import { StreamBreaker, streamBreakerConfig } from "../src/stream-breaker.ts";
import type { SystemOneConfig } from "../src/systemone.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

export function testDeps(
	pool: UpstreamPool,
	opts?: {
		policy?: GatewayPolicy;
		prefs?: Prefs;
		sleepMs?: (ms: number) => Promise<void>;
		accountPolicy?: AccountPolicyDoc | null;
		/** External cooldown state — lets a test bench a deployment before
		 *  the first decision (eject + table.rebuild()). */
		cooldowns?: Cooldowns;
		/** W2266: injectable cooldown clock — bench-window tests advance it
		 *  instead of sleeping real seconds. */
		now?: () => number;
		systemonePolicy?: SystemOneConfig;
	},
): AppDeps {
	const policy: GatewayPolicy = opts?.policy ?? {
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
	};
	const cooldowns =
		opts?.cooldowns ??
		new Cooldowns(
			policy.allowed_fails ?? 3,
			policy.cooldown_time ?? 30,
			opts?.now,
		);
	// W2266: the terminal-SSE breaker rides the SAME Cooldowns instance the
	// walk reads — server-shaped: a fresh bench rebuilds the table NOW so
	// the next decision skips the failing row (never the 5s-tick delay).
	const table = new CandidateTable({ pool, policy, cooldowns });
	const streamBreaker = new StreamBreaker(cooldowns, {
		...streamBreakerConfig(policy),
		onChange: () => table.rebuild(),
	});
	const router = new Router(policy, {
		pool,
		cooldowns,
		sleepMs: opts?.sleepMs,
	});
	const prefs: Prefs = opts?.prefs ?? {
		cost_speed: "balanced",
		allow_cloud: false,
	};
	const decide = (input: {
		group: string;
		dialect: "openai" | "anthropic";
		hint: RouteHint | null;
		hintRaw: string;
		allowCross: boolean;
		providerPin?: string;
	}) => {
		const { providerPin, ...rest } = input;
		return decideRoute({
			...rest,
			candidates:
				providerPin === undefined
					? table.snapshot()
					: table.snapshot().filter((r) => r.dep.adapter === providerPin),
			prefs,
			fallbackGroups: rest.allowCross ? policy.fallbacks?.[rest.group] : [],
		});
	};
	const aidsPolicy = policy.aids ?? {};
	return {
		router,
		ledger: new Ledger(":memory:"),
		aids: new AidsLedger(":memory:"),
		preseeder: new Preseeder({
			policy: aidsPolicy,
			knowledgeUrl: "http://127.0.0.1:1",
		}),
		aidsPolicy,
		sm: servicemon({ service: "buckle-test", port: 0 }),
		pool,
		decide,
		table,
		streamBreaker,
		accountPolicy: opts?.accountPolicy,
		systemonePolicy: opts?.systemonePolicy,
		policy,
	};
}
