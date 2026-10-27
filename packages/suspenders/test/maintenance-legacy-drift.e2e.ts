// test/maintenance-legacy-drift.test.ts — W1256.1 drift test: the heartbeat
// fold contract between fleet-loop's MAINTENANCE_TASKS and services.yaml
// legacyLabels. Every maintenance task name sits in EXACTLY ONE partition:
//   folded — a com.suspenders.<name> launchd unit existed once; its label
//            MUST ride legacyLabels so install --with-launchd boot-outs the
//            unit and the heartbeat owns the cadence (the W779 nine).
//   heartbeat-born — the task was born on the heartbeat (never a unit); a
//            legacy label for it would be a lie and MUST NOT appear.
// Reverse: every com.suspenders.* legacy label names a folded task or an
// explicitly documented non-task retiree. Drift on either side fails here
// instead of duplicating or orphaning the maintenance work on machines.
import { expect, test } from "@playwright/test";
import { MAINTENANCE_TASKS } from "../hooks/lib/fleet-loop/maintenance.ts";
import { loadLegacyLabels, loadManifest } from "../scripts/install-services.ts";

const PREFIX = "com.suspenders.";

// Heartbeat-born W779+ tasks — never had a launchd unit, so nothing to boot
// out. The value documents the item that added the task (audit trail).
const HEARTBEAT_BORN: Record<string, string> = {
	"quota-lift-retry": "W804",
	"usage-mining": "W826",
	"rogue-reap": "W827",
	"license-audit": "W828",
	"metrics-alert": "W782.2.1",
	"cache-sla": "W1139.1",
	"knowledge-sync": "W944",
	"openrouter-free-refresh":
		"452bfdf6 — OpenRouter free catalog (pre-W-id commit)",
	"chatgpt-coordinate": "W1013",
	"signals-scan": "W969",
	"review-reconcile": "W1280",
	"launch-janitor": "W1247",
	"decant-daily": "W1212",
};

// Retired com.suspenders.* labels that were never maintenance tasks —
// retired server residents keeping their boot-out coverage.
const NON_TASK_RETIREES: Record<string, string> = {
	"local-llm":
		"W284 — the suspenders local-llm serve fork (server, not a task)",
};

const tasks = new Set(MAINTENANCE_TASKS.map((t) => t.name));
const suspendersLegacy = loadLegacyLabels().filter((l) => l.startsWith(PREFIX));
const stripped = new Set(suspendersLegacy.map((l) => l.slice(PREFIX.length)));

test.describe("maintenance/legacyLabels drift contract (W1256.1)", () => {
	test("every task is exactly one partition: folded (label covered) or heartbeat-born", () => {
		for (const name of tasks) {
			const covered = stripped.has(name);
			if (name in HEARTBEAT_BORN) {
				// heartbeat-born: no unit ever existed — a boot-out label is drift
				expect(covered).toBe(false);
			} else {
				// folded: the retired unit's label must cover the name
				expect(covered).toBe(true);
			}
		}
	});

	test("every com.suspenders.* legacy label names a task or an explicit retiree", () => {
		for (const name of stripped) {
			expect(
				tasks.has(name) || name in NON_TASK_RETIREES,
				`legacy label ${PREFIX}${name} matches neither a maintenance task nor a documented retiree`,
			).toBe(true);
		}
	});

	test("no task name collides with a live services.yaml unit (duplicate-execution drift)", () => {
		const serviceNames = new Set(loadManifest().map((s) => s.name));
		for (const name of tasks) {
			expect(
				serviceNames.has(name),
				`${name} runs on the heartbeat AND as a launchd unit — the fold must be total`,
			).toBe(false);
		}
	});
});
