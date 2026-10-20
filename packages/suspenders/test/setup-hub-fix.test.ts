// setup-hub-fix.test.ts — W858.7.21: a FAILED hub probe must give a concrete
// recovery path: the check names the failed hub + the measured probe URL in
// the detail, and the fix is a safe read-only status command
// (`bun deploy/hubctl.ts status <label>` — hubctl's read subcommands only).
// Real board on an OS-chosen port, scratch HOME, a hub registry whose only
// candidate is a guaranteed-dead loopback port.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const cfgDir = mkdtempSync(join(tmpdir(), "suspenders-hubfix-"));
const hubsPath = join(cfgDir, "hubs.json");
process.env.SUSPENDERS_HUBS_FILE = hubsPath;
// port 9 (discard): no listener on loopback → the probe fails fast
writeFileSync(
	hubsPath,
	`${JSON.stringify({ nas: { candidates: ["http://127.0.0.1:9"] } }, null, "\t")}\n`,
);

const { BASE } = await boardFixture(0, afterAll);

afterAll(() => {
	delete process.env.SUSPENDERS_HUBS_FILE;
	rmSync(cfgDir, { recursive: true, force: true });
});

describe("W858.7.21 setup hub failure recovery path", () => {
	test("failed hub probe names hub + measured URL + safe status command", async () => {
		const r = await (await fetch(`${BASE}/api/setup`)).json();
		const byId = Object.fromEntries(
			r.checks.map((c: Record<string, unknown>) => [c.id, c]),
		);
		expect(byId.hubs.ok).toBe(false);
		expect(String(byId.hubs.detail)).toMatch(
			/nas no answer at http:\/\/127\.0\.0\.1:9/,
		);
		expect(byId.hubs.fix).toBe("bun deploy/hubctl.ts status nas");
	});
});
