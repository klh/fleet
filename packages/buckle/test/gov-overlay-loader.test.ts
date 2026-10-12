// test/gov-overlay-loader.test.ts — W235: the overlay loader's full law in
// CI — solo (unset) is not an error; a set path must be under an allow
// root; the manifest is strict; the version handshake fails closed; the
// entry digest must match the manifest; an operator pin is enforced; the
// loaded module's hooks register with the gate. Uses the CI fixture overlay
// (test/fixtures/overlay/entry.ts) — zero enterprise code, CI-safe.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.ts";
import {
	OVERLAY_PROTOCOL_VERSION,
} from "../src/gov/adaptation.ts";
import {
	loadOverlay,
	overlayDirAllowed,
	parseOverlayManifest,
	pathToFileUrl,
} from "../src/gov/overlay-loader.ts";

/** Materialize the fixture overlay into a temp dir under `root`: copy the
 *  fixture entry, compute the real entry digest, write manifest.json. */
async function materializeFixture(
	root: string,
	manifest: Record<string, unknown>,
): Promise<string> {
	const dir = join(root, "ovl");
	await cp(
		join(import.meta.dir, "fixtures", "overlay"),
		dir,
		{ recursive: true },
	);
	const body = await readFile(join(dir, "entry.ts"), "utf8");
	const sha = createHash("sha256").update(body).digest("hex");
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({ protocol: OVERLAY_PROTOCOL_VERSION, sha256: sha, ...manifest }, null, "\t"),
	);
	return dir;
}

/** A temp allow-root (macOS /tmp is a symlink to /private/tmp — realpath
 *  both sides). */
async function allowRoot(): Promise<string> {
	return mkdtemp(join(await realpath(tmpdir()), "w235-ovl-"));
}

describe("overlay loader — refusal laws", () => {
	test("unset dir = solo state, not an error", async () => {
		const r = await loadOverlay({ dir: undefined });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toBe("unset");
	});
	test("overlay endpoint outside BUCKLE_EGRESS_ALLOW refuses", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, {
			name: "fx",
			entry: "entry.ts",
			endpoints: ["https://api.example.com"],
		});
		process.env["BUCKLE_EGRESS_ALLOW"] = "";
		const r = await loadOverlay({ dir, allowRoots: [root] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("BUCKLE_EGRESS_ALLOW");
		// allowlisted host loads (loopback never needs the allowlist)
		process.env["BUCKLE_EGRESS_ALLOW"] = "api.example.com";
		const ok = await loadOverlay({ dir, allowRoots: [root] });
		expect(ok.ok).toBe(true);
		process.env["BUCKLE_EGRESS_ALLOW"] = "";
	});
	test("path outside the allowlist refuses", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, { name: "fx", entry: "entry.ts" });
		const outside = join(root, "elsewhere");
		const r = await loadOverlay({ dir, allowRoots: [outside] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("not allowlisted");
	});
});

describe("overlay loader — version handshake + digest + pin", () => {
	test("protocol mismatch refuses (fail-closed handshake)", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, {
			name: "fx",
			entry: "entry.ts",
			protocol: OVERLAY_PROTOCOL_VERSION + 1,
		});
		const r = await loadOverlay({ dir, allowRoots: [root] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("protocol handshake failed");
	});
	test("entry digest mismatch refuses", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, {
			name: "fx",
			entry: "entry.ts",
			sha256: "0".repeat(64),
		});
		const r = await loadOverlay({ dir, allowRoots: [root] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("entry digest mismatch");
	});
	test("operator pin mismatch refuses; honest pin loads", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, { name: "fx", entry: "entry.ts" });
		const good = createHash("sha256")
			.update(await readFile(join(dir, "entry.ts"), "utf8"))
			.digest("hex");
		const r = await loadOverlay({
			dir,
			allowRoots: [root],
			expectSha256: "f".repeat(64),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("operator pin mismatch");
		const ok = await loadOverlay({
			dir,
			allowRoots: [root],
			expectSha256: good,
		});
		expect(ok.ok).toBe(true);
	});
});

describe("overlay loader — CI fixture registers with the gate", () => {
	test("loaded fixture module rides the gate", async () => {
		const root = await allowRoot();
		const dir = await materializeFixture(root, { name: "fx", entry: "entry.ts" });
		const r = await loadOverlay({ dir, allowRoots: [root] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const mod = r.module as {
			createAdaptation: () => unknown;
		};
		const srv = startServer({
			port: 0,
			dbPath: ":memory:",
			auth: {
				rootKey: "rk",
				adaptation: mod.createAdaptation() as never,
			},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`);
			expect(res.status).toBe(401);
		} finally {
			srv.stop(true);
		}
	});
});
