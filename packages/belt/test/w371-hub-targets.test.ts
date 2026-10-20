// W371 — hubTargets heal wiring: a hubs.json label with a stack.yaml profile
// declaring deploy.dir carries heal + quietHours + the hub bind budget;
// profile-less or stack-less machines stay probe-only (W351 unchanged).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	snapshotFromCatalog,
	writeFreeSnapshot,
} from "../../suspenders/deploy/openrouter-free.ts";
import { ZAI_CATALOG_URL } from "../bin/zai-catalog-rows.ts";
import { hubConsoleLinks, hubGatewayRoutes, hubTargets } from "../bin/hubs.ts";

const dir = mkdtempSync(join(tmpdir(), "w371t-"));
const stackPath = join(dir, "stack.yaml");
const hubsPath = join(dir, "hubs.json");
afterAll(() => {
	delete process.env.KLH_STACK;
	delete process.env.SUSPENDERS_HUBS_FILE;
	rmSync(dir, { recursive: true, force: true });
});

const STACK = `version: 0000000000000000000000000000000000000001
hubs:
  nas:
    host: nas.example.lan
    display_name: Lab NAS
    provider_intents: [openai, openrouter]
    console_url: https://nas.example.lan/board
    url: http://nas.example.lan:4101
    deploy:
      ssh: kk@nas.example.lan
      dir: /volume1/hub
      docker: /usr/local/bin/docker
    upstreams:
      groups:
        sample-model:
          - url: https://models.example.org
            model: sample-model
        alternate-route:
          - url: https://models.example.org
            model: sample-model
        unspecified-route:
          - url: http://127.0.0.1:8902
`;

writeFileSync(stackPath, STACK);
process.env.KLH_STACK = stackPath;

writeFileSync(
	hubsPath,
	JSON.stringify({
		nas: { candidates: ["http://nas.example.lan:4101"] },
		DECOY: { candidates: ["https://decoy.example.lan"] },
	}),
);
process.env.SUSPENDERS_HUBS_FILE = hubsPath;

describe("hubTargets heal wiring", () => {
	test("gateway models come from each registered hub profile", () => {
		expect(hubGatewayRoutes()).toEqual([
			{
				name: "nas",
				models: ["sample-model"],
				routeCount: 3,
				unresolvedRoutes: ["unspecified-route"],
				routesByModel: {
					"sample-model": ["sample-model", "alternate-route"],
				},
				providerIntents: ["openai", "openrouter"],
				providerHosts: ["models.example.org"],
				providerHostsByModel: { "sample-model": ["models.example.org"] },
				targetPortsByModel: { "sample-model": [443] },
				providerModelIds: {},
			},
			{
				name: "DECOY",
				models: [],
				routeCount: 0,
				unresolvedRoutes: [],
				routesByModel: {},
				providerIntents: [],
				providerHosts: [],
				providerHostsByModel: {},
				targetPortsByModel: {},
				providerModelIds: {},
			},
		]);
	});
	test("fresh generated OpenRouter routes appear in the hub, then disappear when stale", () => {
		const snapshotPath = join(dir, "openrouter-free.json");
		const snapshot = snapshotFromCatalog({
			data: [
				{
					id: "vendor/model:free",
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					pricing: { prompt: "0", completion: "0" },
				},
			],
		});
		writeFreeSnapshot(snapshotPath, snapshot);
		writeFileSync(
			stackPath,
			STACK.replace(
				"    upstreams:\n",
				`    buckle_prefs:\n      allow_cloud: true\n    secrets:\n      upstream_keys:\n        LITELLM_KEY: /tmp/litellm.key\n    upstreams:\n      openrouter_free_catalog_file: ${snapshotPath}\n`,
			),
		);
		try {
			const fresh = hubGatewayRoutes()[0];
			expect(fresh?.models).toContain("openrouter/vendor/model:free");
			expect(fresh?.routeCount).toBe(4);
			writeFileSync(
				snapshotPath,
				JSON.stringify({ ...snapshot, generated_at: "2020-01-01T00:00:00Z" }),
			);
			const stale = hubGatewayRoutes()[0];
			expect(stale?.models).toEqual(["sample-model"]);
			expect(stale?.routeCount).toBe(3);
		} finally {
			writeFileSync(stackPath, STACK);
		}
	});
	test("Z.ai model identity comes only from this hub's fresh private catalog", () => {
		const snapshotPath = join(dir, "zai-models.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				version: 1,
				source: ZAI_CATALOG_URL,
				generated_at: new Date().toISOString(),
				model_ids: ["glm-5.3"],
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			stackPath,
			STACK.replace(
				"    upstreams:\n",
				`    buckle_prefs:\n      allow_cloud: true\n    http_upstream_hosts: [127.0.0.1]\n    secrets:\n      upstream_keys:\n        LITELLM_KEY: /tmp/litellm.key\n    upstreams:\n      zai_catalog_file: ${snapshotPath}\n      zai_litellm_url: http://127.0.0.1:4100\n`,
			),
		);
		try {
			const fresh = hubGatewayRoutes()[0];
			expect(fresh?.models).toContain("zai-glm-5.3");
			expect(fresh?.providerModelIds["zai-glm-5.3"]).toEqual({
				provider: "zai",
				id: "glm-5.3",
			});
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					version: 1,
					source: ZAI_CATALOG_URL,
					generated_at: "2020-01-01T00:00:00Z",
					model_ids: ["glm-5.3"],
				}),
			);
			const stale = hubGatewayRoutes()[0];
			expect(stale?.models).toEqual(["sample-model"]);
			expect(stale?.providerModelIds).toEqual({});
		} finally {
			writeFileSync(stackPath, STACK);
		}
	});
	test("stack console URL joins the registered hub without using the probe URL", () => {
		expect(hubConsoleLinks()).toEqual([
			{ name: "nas", url: "https://nas.example.lan/board" },
		]);
	});
	test("profile join is case-insensitive; heal row carries heal + quietHours", () => {
		const row = hubTargets().find((r) => r.name === "nas");
		expect(row?.heal).toBeInstanceOf(Function);
		expect(row?.quietHours).toBeInstanceOf(Function);
		expect(row?.bindTimeoutMs).toBe(90_000);
		expect(row?.displayName).toBe("Lab NAS");
	});

	test("profile-less row stays probe-only", () => {
		const row = hubTargets().find((r) => r.name === "DECOY");
		expect(row?.heal).toBeUndefined();
		expect(row?.quietHours).toBeUndefined();
	});

	test("missing stack.yaml → all rows probe-only", () => {
		process.env.KLH_STACK = join(dir, "absent.yaml");
		const rows = hubTargets();
		expect(rows.every((r) => r.heal === undefined)).toBe(true);
		process.env.KLH_STACK = stackPath;
	});
});
