// W2618 hub admission caps: the stack.json hub profile block renders into
// the compose .env as one JSON line (BUCKLE_ADMISSION_CAPS), absent block
// renders nothing, and the compose template maps it into the buckle
// container env. One JSON.parse-able payload — the buckle side safeParses
// the same shape (AdmissionCapsSchema) and stays inert on drift.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { renderEnv } from "../deploy/hub-env-render.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

const TPL = readFileSync(
	join(import.meta.dir, "../deploy/hub-compose.yaml"),
	"utf8",
);

test("admission_caps render as one JSON env line; absent block renders nothing", () => {
	const caps = {
		hub_total: 16,
		user_default: 4,
		users: { "k-s1": 8 },
		models: { "glm-5.3": 12, "claude-fable-5-1": 4 },
	};
	const hub = { host: "nas.example", admission_caps: caps } as HubProfile;
	const env = renderEnv(hub, "w2618", undefined, "v1.2.3");
	const line = env
		.split("\n")
		.find((l) => l.startsWith("HUB_BUCKLE_ADMISSION_CAPS="));
	expect(line).toBeDefined();
	expect(JSON.parse((line ?? "").split("=").slice(1).join("="))).toEqual(caps);
	const bare = renderEnv(
		{ host: "nas.example" } as HubProfile,
		"w2618",
		undefined,
		"v1.2.3",
	);
	expect(bare).not.toContain("ADMISSION_CAPS");
});

test("the compose template maps the cap line into the buckle container", () => {
	expect(TPL).toContain("BUCKLE_ADMISSION_CAPS:");
	expect(TPL).toContain("HUB_BUCKLE_ADMISSION_CAPS:-");
});
