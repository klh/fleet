// test/network-card-lifecycle.test.ts — W1312: the Network card renders the
// joined lifecycle + loss section. Source-contract pin (the board-status-badge
// pattern): the card must keep the WHY line on an empty projection, the
// gap-only hot loss rows, and the attempts-drift marker on the sample rows.
import { expect, test } from "./pw";
import { readFileSync } from "node:fs";

const CARD = readFileSync(
	new URL("../hooks/board-html/klh-network-card.ts", import.meta.url),
	"utf8",
);

test.describe("network card lifecycle section (W1312)", () => {
	test("lifecycleSection renders counters, gap-only loss rows, and the sample", () => {
		expect(CARD).toContain("const lifecycleSection");
		// totals row: emitted/observed/gaps with the hot class on gaps
		expect(CARD).toMatch(/gaps \$\{l\.totals\.gaps\}<\/span>/);
		// loss rows: only sources with gaps, styled hot
		expect(CARD).toMatch(/\.filter\(\(r\) => r\.gaps > 0\)/);
		expect(CARD).toContain('class="num hot">gap ${r.gaps} of ${r.emitted}');
		// sample rows: outcome + attempts-drift marker
		expect(CARD).toContain('${row.outcome ?? "in flight"}');
		expect(CARD).toContain("att p${row.edgeAttempts");
	});

	test("hubSection mounts the lifecycle section (loss is visible on the board)", () => {
		expect(CARD).toContain("${lifecycleSection(n)}");
	});
});
