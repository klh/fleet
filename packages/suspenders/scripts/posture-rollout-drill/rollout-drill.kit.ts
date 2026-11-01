// scripts/posture-rollout-drill/rollout-drill.kit.ts — W1315.6 shared kit.
// The four rollout drills (drill-{store,runtime,board,drain}.ts) prove the
// INSTALLED runtime generation consumes a migrated posture config. Paths are
// machine-neutral: the installed tree resolves through the live
// ~/.claude/hooks/suspenders symlink (SUSPENDERS_INSTALLED overrides), the
// machine conf through KLH_STACK (default ~/.config/klh/stack.json). The
// drills NEVER write the machine conf — drill A copies its bytes into a
// scratch world and mutates the copy.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const INSTALLED =
	process.env.SUSPENDERS_INSTALLED ??
	`${homedir()}/.claude/hooks/suspenders/.harness/packages/suspenders`;

export const MACHINE_CONF =
	process.env.KLH_STACK ?? `${homedir()}/.config/klh/stack.json`;

export const assert = (cond: boolean, label: string): void => {
	if (!cond) throw new Error(`DRILL FAIL: ${label}`);
	console.log(`ok — ${label}`);
};

/** The W1315.6 proposed posture document — mirrors the live exec-chain must
 *  set (must=glm-5.3-flash,glm-5.3,glm-5.2, order flash-first) plus CAN
 *  development entries; NO legacy Plaid guesses. Fleet compositions avoid
 *  model overlap: cloud+canary both define glm-4.5-air with different
 *  ceilings — the resolver rejects conflicting compositions (drill A). */
export const rolloutDocument = (): Record<string, unknown> => ({
	version: 1,
	selection: {
		fleet: "main",
		posture: "standard",
		developmentOverride: false,
	},
	fleets: {
		main: {
			postures: {
				standard: ["local.cloud"],
				minimal: ["local.minimal"],
				dev: ["local.minimal", "local.canary"],
			},
		},
	},
	hubs: {
		local: {
			profiles: {
				cloud: {
					models: {
						"glm-5.3-flash": { policy: "MUST", lanes: "MAX" },
						"glm-5.3": { policy: "MUST", lanes: "MAX" },
						"glm-5.2": { policy: "MUST", lanes: "MAX" },
						"glm-4.5-air": { policy: "CAN", lanes: "MAX" },
					},
				},
				minimal: {
					models: { "glm-5.3-flash": { policy: "MUST", lanes: 2 } },
				},
				canary: {
					models: {
						"glm-4.5-air": { policy: "CAN", lanes: 1 },
						"local-swarm": { policy: "CAN", lanes: 1 },
					},
				},
			},
		},
	},
});

/** A scratch world + a byte-copy of the machine conf inside it. Every run
 *  starts from the untouched machine-conf bytes; the machine file itself is
 *  never opened for writing. */
export function scratchConf(label: string): {
	world: string;
	conf: string;
	reset: () => void;
	clean: () => void;
} {
	const world = join(homedir(), ".cache", `posture-drill-${label}`);
	rmSync(world, { recursive: true, force: true });
	mkdirSync(world, { recursive: true });
	const pristine = join(world, "stack.pristine.json");
	const conf = join(world, "stack.json");
	copyFileSync(MACHINE_CONF, pristine);
	copyFileSync(MACHINE_CONF, conf);
	const reset = (): void => {
		copyFileSync(pristine, conf);
		rmSync(`${conf}.pre-postures.bak.json`, { force: true });
	};
	reset();
	return {
		world,
		conf,
		reset,
		clean: () => rmSync(world, { recursive: true, force: true }),
	};
}

/** Absolute dynamic import into the INSTALLED generation. */
export const installed = async <T>(rel: string): Promise<T> =>
	(await import(`${INSTALLED}/${rel}`)) as T;
