// test/install-pi.e2e.ts — W2861: the install's pi models face. Prove on a
// scratch HOME: a live stub face + a down hub → models.json written 0600
// with the marker, `!`-command keys (never literal key material), down hub
// skipped; user-authored models.json (no marker) preserved byte-exact;
// pi absent → skipped; all faces down → skipped; dry-run writes nothing.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installPiModels } from "../scripts/install/install-pi.ts";
import { scratchWorld, serveStub } from "@klh/test-kit";

/** Scratch pi home + machine-conf dir with a stub-tokened hub set. */
const confFixture = (
	home: string,
	hubs: Record<string, { candidates: string[]; token: string }>,
): void => {
	const conf = join(home, ".claude", "local-llm");
	mkdirSync(conf, { recursive: true });
	writeFileSync(
		join(conf, "buckle-spoke.env"),
		"BUCKLE_ROOT_KEY=spoke-test-key\n",
		{ mode: 0o600 },
	);
	writeFileSync(join(conf, "hubs.json"), JSON.stringify(hubs));
};

/** A stub fleet face answering /v1/models with the given model ids. */
const modelsStub = (...ids: string[]) =>
	serveStub(
		() =>
			new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
				headers: { "content-type": "application/json" },
			}),
	);

test.describe("installPiModels (W2861) @unit", () => {
	test("writes 0600 models.json with marker + !-command keys, down hub skipped", async () => {
		const w = scratchWorld({ prefix: "w2861-pi-" });
		try {
			const spoke = modelsStub("glm-5.3", "claude-sonnet-5");
			const desktop = modelsStub("desktop-model");
			try {
				mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
				confFixture(w.home, {
					desktop: { candidates: [desktop.url], token: "hub-test-token" },
					nas: { candidates: ["http://127.0.0.1:9"], token: "hub-nas-token" },
				});
				const r = await installPiModels({
					home: w.home,
					spokeUrl: spoke.url,
					probeTimeoutMs: 300,
				});
				expect(r.status).toBe("ok");
				expect(r.providers).toContain("fleet");
				expect(r.providers).toContain("fleet-desktop");
				expect(r.providers).not.toContain("fleet-nas");
				const modelsPath = join(w.home, ".pi", "agent", "models.json");
				const mode = statSync(modelsPath).mode & 0o777;
				expect(mode).toBe(0o600);
				const text = readFileSync(modelsPath, "utf8");
				expect(text).toContain("$fleetGenerated");
				expect(text).not.toContain("spoke-test-key");
				expect(text).not.toContain("hub-test-token");
				expect(text).toContain("!sed -n");
			} finally {
				spoke.close();
				desktop.close();
			}
		} finally {
			w.clean();
		}
	});

	test("preserves user-authored models.json byte-exact", async () => {
		const w = scratchWorld({ prefix: "w2861-pi-user-" });
		try {
			mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
			confFixture(w.home, {});
			const modelsPath = join(w.home, ".pi", "agent", "models.json");
			const user = '{"providers":{"mine":{"baseUrl":"https://x"}}}\n';
			writeFileSync(modelsPath, user, { mode: 0o600 });
			const r = await installPiModels({ home: w.home, probeTimeoutMs: 300 });
			expect(r.status).toBe("skipped");
			expect(r.note).toContain("user content");
			expect(readFileSync(modelsPath, "utf8")).toBe(user);
		} finally {
			w.clean();
		}
	});

	test("skips when pi is not installed", async () => {
		const w = scratchWorld({ prefix: "w2861-pi-absent-" });
		try {
			confFixture(w.home, {});
			const r = await installPiModels({ home: w.home, probeTimeoutMs: 300 });
			expect(r.status).toBe("skipped");
			expect(r.note).toContain("pi not installed");
		} finally {
			w.clean();
		}
	});

	test("skips when every fleet face is down", async () => {
		const w = scratchWorld({ prefix: "w2861-pi-down-" });
		try {
			mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
			confFixture(w.home, {
				nas: { candidates: ["http://127.0.0.1:9"], token: "hub-nas-token" },
			});
			const r = await installPiModels({
				home: w.home,
				spokeUrl: "http://127.0.0.1:9",
				probeTimeoutMs: 300,
			});
			expect(r.status).toBe("skipped");
			expect(r.note).toContain("no reachable fleet face");
			expect(r.providers).toEqual([]);
		} finally {
			w.clean();
		}
	});

	test("dry-run plans without writing", async () => {
		const w = scratchWorld({ prefix: "w2861-pi-dry-" });
		try {
			const stub = modelsStub("m1");
			try {
				mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
				confFixture(w.home, {});
				const r = await installPiModels({
					home: w.home,
					spokeUrl: stub.url,
					probeTimeoutMs: 300,
					dryRun: true,
				});
				expect(r.status).toBe("planned");
				expect(r.providers).toEqual(["fleet"]);
				expect(existsSync(join(w.home, ".pi", "agent", "models.json"))).toBe(
					false,
				);
			} finally {
				stub.close();
			}
		} finally {
			w.clean();
		}
	});
});
