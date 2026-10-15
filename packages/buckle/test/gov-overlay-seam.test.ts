// test/gov-overlay-seam.test.ts — W688.3: the gov factories ride the loaded
// overlay module (createGovSeam) into startServer auth opts. Solo posture
// (no overlay) is unchanged — honest 501s. Covers the extraction contract
// (fail-closed shapes) and the full boot() path: an overlay on disk with a
// hubEntitlements factory serves the entitlements menu where the solo gate
// answers buckle.no_federation.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	overlayModuleGovSeam,
	type GovSeamFactories,
} from "../src/gov/overlay-loader.ts";
import { boot } from "../src/server.ts";

const tmp = mkdtempSync(join(tmpdir(), "fleet-gov-seam-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// env knobs this suite mutates — saved + restored around every boot() walk
const ENV_KEYS = [
	"KLH_OVERLAY_DIR",
	"KLH_OVERLAY_ALLOW",
	"KLH_OVERLAY_SHA256",
	"BUCKLE_PORT",
	"BUCKLE_ROOT_KEY",
	"BUCKLE_AUTH",
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));
afterAll(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** Deterministic solo vs overlay env for each boot walk. */
function envFor(mode: "solo" | "overlay", dir?: string): void {
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.BUCKLE_PORT = "0";
	process.env.BUCKLE_AUTH = "on";
	process.env.BUCKLE_ROOT_KEY = "seam-test-root";
	if (mode === "overlay" && dir) {
		process.env.KLH_OVERLAY_DIR = dir;
		process.env.KLH_OVERLAY_ALLOW = tmp;
	}
}

/** Minimal valid overlay on disk: manifest + entry exporting createGovSeam. */
async function writeOverlay(name: string, entryBody: string): Promise<string> {
	const dir = join(tmp, name);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(dir, { recursive: true });
	const entryPath = join(dir, "entry.ts");
	await Bun.write(entryPath, entryBody);
	const digest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(entryPath).arrayBuffer())
		.digest("hex");
	await Bun.write(
		join(dir, "manifest.json"),
		JSON.stringify({
			name: "gov-seam-fixture",
			protocol: 1,
			entry: "entry.ts",
			sha256: digest,
		}),
	);
	return dir;
}

const ENT_MENU = `export function createGovSeam() {
	return {
		hubEntitlements: () => ({
			models: () => [],
		}),
	};
};
`;

async function bootWalk(mode: "solo" | "overlay", dir?: string) {
	envFor(mode, dir);
	const server = await boot();
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

describe("overlay gov seam — extraction contract", () => {
	test("absent export = solo posture (undefined)", () => {
		expect(overlayModuleGovSeam({})).toBeUndefined();
		expect(overlayModuleGovSeam(null)).toBeUndefined();
	});
	test("non-function export or member throws (fail-closed)", () => {
		expect(() => overlayModuleGovSeam({ createGovSeam: 42 })).toThrow();
		expect(() =>
			overlayModuleGovSeam({ createGovSeam: () => ({ hubEntitlements: 7 }) }),
		).toThrow();
	});
	test("valid surface keeps only the four factories", () => {
		const f = overlayModuleGovSeam({
			createGovSeam: () => ({
				hubEntitlements: () => ({ models: () => [] }),
				junk: true,
			}),
		}) as GovSeamFactories | undefined;
		expect(Object.keys(f ?? {})).toEqual(["hubEntitlements"]);
	});
});

describe("overlay gov seam — the boot() walk", () => {
	test("solo posture: entitlements route answers honest 501", async () => {
		const { base, stop } = await bootWalk("solo");
		try {
			const res = await fetch(`${base}/federation/entitlements`, {
				headers: { authorization: "Bearer seam-test-root" },
			});
			expect(res.status).toBe(501);
			expect((await res.json()).error.code).toBe("buckle.no_federation");
		} finally {
			stop();
		}
	});
	test("overlay createGovSeam: entitlements route serves the menu", async () => {
		const dir = await writeOverlay("ent", ENT_MENU);
		const { base, stop } = await bootWalk("overlay", dir);
		try {
			const res = await fetch(`${base}/federation/entitlements`, {
				headers: { authorization: "Bearer seam-test-root" },
			});
			expect(res.status).toBe(200);
			expect((await res.json()).models).toEqual([]);
		} finally {
			stop();
		}
	});
});
