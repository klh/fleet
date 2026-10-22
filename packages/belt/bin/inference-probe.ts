#!/usr/bin/env bun
/** W1040 — outside-process provider inference probe.
 *
 *  Sends one tiny real completion per configured cloud provider (targets come
 *  from remotes.json — no hardcoded provider list) and publishes a TTL-bounded
 *  verdict feed that Belt reads separately from catalog reachability and
 *  recent Buckle traffic:
 *    bun bin/inference-probe.ts --once   # one pass, exit
 *    bun bin/inference-probe.ts --loop   # re-probe every half TTL
 *
 *  Feed: ${HOME}/.cache/klh/belt/inference-probe.json — keyed by the same
 *  providerKey() the topology model joins on. Green requires a verified
 *  usable completion; billing 429, quota 429, auth failure, transport death,
 *  stale (past TTL) and untested (absent) stay distinct. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { providerKey } from "./dashboard-topology-model.js";
import {
	classifyInferenceProbe,
	inferenceProbePath,
	type InferenceProbeFeed,
	type InferenceProbeRecord,
} from "./inference-probe-state.ts";
import {
	cdnFetch,
	endpointKey,
	loadStatic,
	type RemoteEndpoint,
	type RemoteMachine,
} from "./remotes.ts";

const parseMs = (raw: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const TTL_MS = parseMs(process.env.BELT_INFERENCE_PROBE_TTL_MS, 10 * 60_000);
const LOOP_MS = Math.max(60_000, Math.floor(TTL_MS / 2));

/** Cloud endpoints carrying a real model id, grouped to one probe per
 *  provider key (first endpoint wins — the feed speaks per provider). */
export const cloudProbeTargets = (
	machines: RemoteMachine[],
): Array<{ key: string; machine: RemoteMachine; ep: RemoteEndpoint }> => {
	const targets = new Map<
		string,
		{ key: string; machine: RemoteMachine; ep: RemoteEndpoint }
	>();
	for (const machine of machines) {
		for (const ep of machine.endpoints ?? []) {
			if (!ep.base || ep.protocol !== "openai" || !ep.model) continue;
			const key = providerKey(machine.host);
			if (!targets.has(key)) targets.set(key, { key, machine, ep });
			break;
		}
	}
	return [...targets.values()];
};

const excerpt = (body: string): string =>
	body.replace(/\s+/g, " ").trim().slice(0, 120);

/** One real 1-token completion through the provider's own wire. Never throws
 *  — transport deaths classify as "failed" with a null HTTP status. */
export const probeOnce = async (
	target: { machine: RemoteMachine; ep: RemoteEndpoint },
	now: number,
): Promise<InferenceProbeRecord> => {
	const started = Date.now();
	const key = endpointKey(target.ep);
	const base = {
		state: "failed" as const,
		checkedAt: now,
		expiresAt: now + TTL_MS,
		latencyMs: null,
		model: target.ep.model ?? "",
		detail: "",
		httpStatus: null,
	};
	if (!key)
		return {
			...base,
			detail: `no api key (${target.ep.api_key_env ?? "api_key_env"})`,
		};
	if (!target.ep.model) return { ...base, detail: "no model configured" };
	try {
		const r = await cdnFetch(`${target.ep.base}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: target.ep.model,
				max_tokens: 1,
				messages: [{ role: "user", content: "ok" }],
			}),
			signal: AbortSignal.timeout(12_000),
			redirect: "manual",
		});
		const body = await r.text();
		const state = classifyInferenceProbe(r.status, body);
		return {
			...base,
			latencyMs: Date.now() - started,
			httpStatus: r.status,
			state,
			detail:
				state === "ok"
					? `verified inference · ${target.ep.model} · ${Date.now() - started}ms`
					: `HTTP ${r.status} · ${excerpt(body)}`,
		};
	} catch (error) {
		return {
			...base,
			detail: `transport death · ${excerpt(String(error))}`,
		};
	}
};

const writeFeed = async (providers: Record<string, InferenceProbeRecord>) => {
	const feed: InferenceProbeFeed = { ts: Date.now(), providers };
	const path = inferenceProbePath();
	mkdirSync(dirname(path), { recursive: true });
	await Bun.write(path, `${JSON.stringify(feed, null, "\t")}\n`);
};

const runOnce = async (): Promise<void> => {
	const now = Date.now();
	const targets = cloudProbeTargets(loadStatic());
	const providers: Record<string, InferenceProbeRecord> = {};
	for (const target of targets) {
		providers[target.key] = await probeOnce(target, now);
	}
	await writeFeed(providers);
	console.log(
		`inference-probe: ${Object.keys(providers).length} provider(s) → ${inferenceProbePath()}`,
	);
};

const main = async (): Promise<void> => {
	if (process.argv.includes("--loop")) {
		for (;;) {
			await runOnce();
			await new Promise((resolve) => setTimeout(resolve, LOOP_MS));
		}
	}
	await runOnce();
};

if (import.meta.main) await main();
