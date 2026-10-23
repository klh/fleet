// bin/fallback-health.ts — W1091: validate configured fallback groups against
// probed deployment health during generated LiteLLM config activation.
// gateway-config.ts extracts every emitted model_name's api_base list, probes
// them, and suppresses ladder rungs whose group has no answering deployment.
// Suppression is EMISSION-TIME ONLY: the operator policy file is never
// rewritten, so the next regen re-probes and restores rungs when a deployment
// returns. No model names here — groups resolve through the generated
// model_list itself.
import type { GatewayPolicy } from "./router-policy.ts";

const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");

/** group → api_base list, parsed from the emitted model_list text (every
 *  emitter — litellmRows, remotes-validate, the anthropic rows — writes the
 *  same `  - model_name: X` … `      api_base: Y` entry block). Tolerant line
 *  scan: any field order inside a block, values may be quoted, a group named
 *  by several deployments accumulates all of its bases. */
export const groupBasesFromModelList = (
	modelList: string,
): Map<string, string[]> => {
	const bases = new Map<string, string[]>();
	let group: string | undefined;
	for (const line of modelList.split("\n")) {
		const name = line.match(/^\s*- model_name:\s*(.+?)\s*$/);
		if (name) {
			group = unquote(name[1]);
			if (!bases.has(group)) bases.set(group, []);
			continue;
		}
		const base = line.match(/^\s+api_base:\s*(.+?)\s*$/);
		if (base && group !== undefined) {
			const url = unquote(base[1]);
			const list = bases.get(group);
			if (list && !list.includes(url)) list.push(url);
		}
	}
	return bases;
};

/** Any HTTP answer (any status) proves the deployment is up; refused, timed
 *  out or otherwise unanswerable is down. Bases probe concurrently so one
 *  slow cloud endpoint cannot stretch the whole pass. */
export const probeDeploymentHealth = async (
	bases: Map<string, string[]>,
	timeoutMs = 2_000,
): Promise<Set<string>> => {
	const alive = new Set<string>();
	await Promise.all(
		[...bases.entries()].flatMap(([group, urls]) =>
			urls.map(async (url) => {
				try {
					await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
					alive.add(group);
				} catch {
					// unreachable — the group stays dead unless another base answers
				}
			}),
		),
	);
	return alive;
};

export interface FallbackSuppression {
	/** The operator policy with unreachable rungs filtered out — emit this. */
	policy: GatewayPolicy;
	/** Human-readable `group: rung` pairs removed from the emitted ladders. */
	suppressed: string[];
}

/** Pure filter: a rung stays when its group has no probed deployments (no
 *  evidence — operator policy preserved) or answered the probe; it is
 *  suppressed only when the group exists in the generated model_list and
 *  every one of its bases missed. A ladder row left without rungs is dropped.
 *  Never mutates the input policy. */
export const suppressUnreachableFallbacks = (
	policy: GatewayPolicy,
	bases: Map<string, string[]>,
	alive: Set<string>,
): FallbackSuppression => {
	const suppressed: string[] = [];
	const ladder = (
		rows?: Record<string, string[]>,
	): Record<string, string[]> | undefined => {
		if (!rows) return undefined;
		const out: Record<string, string[]> = {};
		for (const [group, rungs] of Object.entries(rows)) {
			const kept = (rungs ?? []).filter((rung) => {
				const dead = bases.has(rung) && !alive.has(rung);
				if (dead) suppressed.push(`${group}: ${rung}`);
				return !dead;
			});
			if (kept.length > 0) out[group] = kept;
		}
		return out;
	};
	return {
		policy: {
			...policy,
			fallbacks: ladder(policy.fallbacks),
			context_window_fallbacks: ladder(policy.context_window_fallbacks),
		},
		suppressed,
	};
};
