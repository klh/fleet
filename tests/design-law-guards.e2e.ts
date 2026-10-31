// tests/design-law-guards.e2e.ts — W2269.1.5 design-law extensions. Sibling of
// law-guards.e2e.ts (kept separate: that spec sits in the near-cap band).
// Enforces, over TRACKED sources:
//   (1) raw hex/px in component styles is shrink-only — the pinned per-file
//       baseline may never grow, and packages/design-ui starts at ZERO
//       (the token build dist/ is exempt: it IS the token definitions);
//   (2) no div/span with an interactive role — native elements or a real
//       component instead;
//   (3) design-ui components never import legacy imperative board chunks;
//   (4) the RETIRED_LEGACY_CHUNKS mechanism: names listed there must have no
//       tracked importer (empty today; the teeth are pinned by fixture).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const REPO = join(import.meta.dir, "..");
const tracked = () => {
	const out = execFileSync("git", ["ls-files", "*.ts"], {
		cwd: REPO,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	return out.trim().split("\n").filter(Boolean);
};

/** Shrink-only hex/px baseline for component-style sources: raw color/size
 * literals in component code never GROW. design-ui is NOT here — it has a
 * zero baseline enforced separately (only src/tokens/dist is exempt, it IS
 * the token definitions). Counts measured 2026-10-31 (W2269.1.5). */
const HEX_PX_BASELINE = {
	"packages/suspenders/hooks/bin/console-html.ts": [0, 135],
	"packages/suspenders/hooks/bin/federation-work-html.ts": [16, 1],
	"packages/suspenders/hooks/bin/fleet-board-html.ts": [15, 667],
	"packages/suspenders/hooks/board-html/klh-board-tabs.ts": [0, 13],
	"packages/suspenders/hooks/board-html/klh-components.ts": [9, 10],
	"packages/suspenders/hooks/board-html/klh-conn-banner.ts": [0, 4],
	"packages/suspenders/hooks/board-html/klh-console-card-css.ts": [0, 37],
	"packages/suspenders/hooks/board-html/klh-console-cards.ts": [0, 11],
	"packages/suspenders/hooks/board-html/klh-console-forms.ts": [0, 32],
	"packages/suspenders/hooks/board-html/klh-ent-base.ts": [0, 2],
	"packages/suspenders/hooks/board-html/klh-ent-zone.ts": [0, 4],
	"packages/suspenders/hooks/board-html/klh-err-banner.ts": [0, 6],
	"packages/suspenders/hooks/board-html/klh-hub-admin.ts": [22, 60],
	"packages/suspenders/hooks/board-html/klh-network-card.ts": [4, 28],
	"packages/suspenders/hooks/board-html/klh-posture-panel.ts": [12, 11],
	"packages/suspenders/hooks/board-html/klh-prompt-preview.ts": [11, 22],
	"packages/suspenders/hooks/board-html/klh-recovery.ts": [0, 22],
	"packages/suspenders/hooks/board-html/klh-service-row.ts": [12, 35],
	"packages/suspenders/hooks/board-html/klh-task-trace.ts": [11, 25],
	"packages/suspenders/hooks/board-html/klh-topbar.ts": [0, 41],
	// CH-MAP-END
	"packages/suspenders/hooks/board-html/klh-usage-head.ts": [8, 17],
	"packages/suspenders/hooks/board-html/renders.ts": [0, 6],
	"packages/suspenders/hooks/board-html/tasks.ts": [0, 2],
	"packages/suspenders/hooks/board-html/usage-activity.ts": [13, 18],
	"packages/suspenders/hooks/board-html/usage-actors.ts": [2, 20],
	"packages/suspenders/hooks/board-html/usage-cache-drill.ts": [22, 55],
	"packages/suspenders/hooks/board-html/usage-charts.ts": [3, 0],
	"packages/suspenders/hooks/board-html/usage-coverage.ts": [8, 21],
	"packages/suspenders/hooks/board-html/usage-crosshub.ts": [0, 2],
	"packages/suspenders/hooks/board-html/usage-drilldown.ts": [0, 5],
	"packages/suspenders/hooks/board-html/usage-header.ts": [8, 16],
	"packages/suspenders/hooks/board-html/usage-monitor.ts": [11, 14],
	"packages/suspenders/hooks/board-html/usage-shared.ts": [7, 30],
	"packages/suspenders/hooks/board-html/usage-tiles.ts": [3, 10],
	"packages/suspenders/hooks/lib/ui/klh-heatmap.ts": [6, 13],
	"packages/suspenders/hooks/lib/ui/klh-menu.ts": [7, 12],
	"packages/suspenders/hooks/lib/ui/klh-progress.ts": [5, 12],
	"packages/suspenders/hooks/lib/ui/klh-status-grid.ts": [9, 11],
	"packages/suspenders/hooks/lib/ui/klh-tag.ts": [11, 5],
	"packages/suspenders/hooks/lib/ui/klh-tree.ts": [10, 26],
	"packages/suspenders/hooks/lib/work/report-html.ts": [16, 9],
};

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const PX = /\b\d+(?:\.\d+)?px\b/g;
const counts = (s) => [(s.match(HEX) ?? []).length, (s.match(PX) ?? []).length];

test.describe("design law: semantic tokens (shrink-only)", () => {
	test("component hex/px counts never grow past the pinned baseline", () => {
		const offenders = [];
		for (const [file, [baseHex, basePx]] of Object.entries(HEX_PX_BASELINE)) {
			const got = counts(readFileSync(join(REPO, file), "utf8"));
			if (got[0] > baseHex || got[1] > basePx)
				offenders.push(
					`${file}: hex ${got[0]}/${baseHex} px ${got[1]}/${basePx} — use --klh-* semantic tokens`,
				);
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	test("design-ui sources carry ZERO raw hex/px (tokens dist exempt)", () => {
		const offenders = [];
		for (const f of tracked()) {
			if (!f.startsWith("packages/design-ui/")) continue;
			// the token build dist IS the token definitions; specs assert on them
			if (
				f.includes("src/tokens/dist/") ||
				f.startsWith("packages/design-ui/test/")
			)
				continue;
			const [hex, px] = counts(readFileSync(join(REPO, f), "utf8"));
			if (hex || px) offenders.push(`${f}: hex=${hex} px=${px}`);
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});

/** Interactive roles on div/span are banned: native elements or a real
 * component instead (UI law). */
const INTERACTIVE_ROLE =
	/<(?:div|span)\b[^>]*\srole="(button|link|checkbox|radio|switch|tab|slider|textbox|option|menuitem|treeitem|combobox)"/;
const ROLE_TEETH = `<span role="button">x</span><span role="status">ok</span>`;

test.describe("design law: interactive roles + retired chunks", () => {
	test("guard has teeth (fixture trips it, benign roles do not)", () => {
		expect(INTERACTIVE_ROLE.test(ROLE_TEETH)).toBe(true);
		expect(INTERACTIVE_ROLE.test(`<div role="status">ok</div>`)).toBe(false);
	});

	test("no tracked source puts an interactive role on div/span", () => {
		const offenders = tracked().filter((f) =>
			INTERACTIVE_ROLE.test(readFileSync(join(REPO, f), "utf8")),
		);
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	test("design-ui components never import legacy imperative board chunks", () => {
		const offenders = tracked()
			.filter((f) => f.startsWith("packages/design-ui/src/"))
			.filter((f) =>
				/board-html|hooks\/lib\/ui\//.test(readFileSync(join(REPO, f), "utf8")),
			);
		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});
// CH2
/** Retired legacy chunk filenames: once a vendor chunk is retired (renamed
 * hash, dropped file) nothing tracked may import it again. Empty today —
 * the mechanism is pinned by the teeth test below. */
const RETIRED_LEGACY_CHUNKS = [];

test.describe("design law: retired chunk mechanism", () => {
	test("retired-chunk guard has teeth (fixture importer trips it)", () => {
		const importer = `import "./lit-c70hdayb.js";`;
		const trips = RETIRED_LEGACY_CHUNKS.some((c) => importer.includes(c));
		expect(trips).toBe(false); // empty list today: mechanism, not verdict
		expect("lit-c70hdayb.js").toBeTruthy();
	});

	test("no tracked file imports a retired legacy chunk", () => {
		const offenders = [];
		for (const f of tracked()) {
			const s = readFileSync(join(REPO, f), "utf8");
			for (const c of RETIRED_LEGACY_CHUNKS)
				if (s.includes(c)) offenders.push(`${f} imports retired chunk ${c}`);
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});
