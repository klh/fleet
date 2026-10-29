// Ratchet guard — the count of direct knob `process.env.*` reads OUTSIDE
// @klh/settings is shrink-only: every reader migrated to setting() lowers
// the pin in the same commit; a new direct knob read fails this spec.
// Baseline pinned at the settings landing: 62 sites across 57 knob names.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { countKnobEnvSites } from "./helpers.ts";
import { ENV_MAP } from "../src/index.ts";

test("direct knob env reads outside @klh/settings stay at the pin", () => {
	const root = join(import.meta.dir, "..", "..", "..");
	const knobs = new Set(ENV_MAP.map((m) => m.env));
	const r = countKnobEnvSites(root, knobs);
	expect(r.sites).toBeLessThanOrEqual(62);
});
