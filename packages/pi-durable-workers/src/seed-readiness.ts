// src/seed-readiness.ts — W2958: the seed readiness contract, testable core.
// The Pi Durable analogue of the OpenHands sandbox health poll: the seed
// image reports ready only after its runtime initializes — the real
// @klh/pi-durable-workers extension factory constructs, a pi-durable
// registry instantiates, and the required tools are present. The in-image
// wrapper (seed/payload/readiness.ts) calls runReadinessChecks with the
// real probes; tests inject stubs. No network, no credentials, no host
// writes outside the tmp probe.
import { execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { Logger } from "@klh/buckle/src/log";
import { durableWorkers } from "./index.ts";

export const SPEEDY_TOOLS = [
	"rg",
	"fd",
	"bat",
	"sd",
	"jq",
	"fzf",
	"eza",
	"ambr",
] as const;

export const READY_MARKER = "PI_DURABLE_SEED_READY";

/** Silence-level logger — construction must not emit; tool closures run
 *  only inside real agent rounds, which readiness never reaches. */
const silentLogger: Logger = {
	level: "error",
	debug() {},
	info() {},
	warn() {},
	error() {},
};

const probeExtension = (): Extension<ToolRegistration> =>
	durableWorkers({ logger: silentLogger });

export interface ReadinessResult {
	ready: boolean;
	bun: string;
	checks: Record<string, boolean>;
	reason?: string;
}

export interface ReadinessProbes {
	bunVersion: () => string;
	expectedBun: string;
	extensionLoads: () => boolean;
	extensionShape: () => boolean;
	registryInstantiates: () => boolean;
	gitVersion: () => string | null;
	toolPresent: (command: string) => boolean;
	tmpWritable: () => boolean;
}

const hasShape = (ext: Extension<ToolRegistration> | null): boolean => {
	if (ext === null || typeof ext !== "object") return false;
	const candidate = ext as unknown as Record<string, unknown>;
	const tools = candidate.tools;
	const sections = candidate.sections;
	const hooks = candidate.hooks;
	return (
		Array.isArray(tools) &&
		tools.length > 0 &&
		Array.isArray(sections) &&
		sections.length > 0 &&
		hooks !== undefined
	);
};

/** Verify the runtime initializes: the real extension factory constructs
 *  with tools/sections/hooks, and the pi-durable registry instantiates. */
export const runReadinessChecks = (
	probes: ReadinessProbes,
): ReadinessResult => {
	const checks: Record<string, boolean> = {};
	const bun = probes.bunVersion();
	checks.bun_pinned = bun.startsWith(probes.expectedBun);
	checks.extension_loads = probes.extensionLoads();
	checks.extension_shape = probes.extensionShape();
	checks.registry_instantiates = probes.registryInstantiates();
	const git = probes.gitVersion();
	checks.git_present = git !== null;
	for (const tool of SPEEDY_TOOLS)
		checks[`${tool}_present`] = probes.toolPresent(tool);
	checks.tmp_writable = probes.tmpWritable();
	const failed = Object.entries(checks)
		.filter(([, ok]) => !ok)
		.map(([name]) => name);
	return {
		ready: failed.length === 0,
		bun,
		checks,
		...(failed.length > 0 ? { reason: `failed: ${failed.join(",")}` } : {}),
	};
};

/** Real probes for the in-image wrapper — exactly the checks the build
 *  smoke relies on. durableWorkers() transitively loads budget, doom-loop,
 *  approvals, uniform task and wake; failure anywhere fails readiness. */
export const realProbes = (expectedBun: string): ReadinessProbes => ({
	bunVersion: () => Bun.version,
	expectedBun,
	extensionLoads: () => {
		try {
			return probeExtension() !== null;
		} catch {
			return false;
		}
	},
	extensionShape: () => {
		try {
			return hasShape(probeExtension());
		} catch {
			return false;
		}
	},
	registryInstantiates: () => {
		try {
			return createRegistry() !== null;
		} catch {
			return false;
		}
	},
	gitVersion: () => {
		try {
			const out = execFileSync("git", ["--version"], {
				timeout: 5_000,
				encoding: "utf8",
			}).trim();
			return out.length > 0 ? out : null;
		} catch {
			return null;
		}
	},
	toolPresent: (command) => Bun.which(command) !== null,
	tmpWritable: () => {
		try {
			const dir = mkdtempSync("/tmp/pi-durable-seed-ready-");
			const probe = `${dir}/probe`;
			writeFileSync(probe, "ok");
			unlinkSync(probe);
			return true;
		} catch {
			return false;
		}
	},
});
