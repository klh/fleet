// test/w836-board-facts.test.ts — W836 board facts trust panel: /api/data
// carries the lesson.*/finding.* facts with the parsed trust marker (the
// {rating, detail, evidence, researched} JSON the `coord fact` schema note
// teaches), and the served page mounts the facts container. Live board on
// an OS-pick port (boardFixture — scratch HOME/repo, auto-rm).
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { boardFixture, unusedPort } from "./helpers/board-fixture.ts";
type Row = Record<string, unknown>;

const { HOME, env, bin, waitUp, setDemoProc, sleep } = await boardFixture(
	0,
	test.afterAll,
);

const PORT = unusedPort();
const BASE = `http://127.0.0.1:${PORT}`;

const board = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--demo", "--port", String(PORT)],
	{ env, stdout: "pipe", stderr: "pipe" },
);
setDemoProc(board);

const run = (args: string[]): void => {
	Bun.spawnSync(["bun", join(bin, "coord.ts"), ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
};

test.describe("W836 board facts trust panel", () => {
	test("/api/data carries facts with the trust marker; page mounts the section", async () => {
		await waitUp(BASE);
		// seed one schema-shaped fact + one plain-text fact
		run([
			"fact",
			"set",
			"lesson.w836.demo",
			'{"rating":"solid","detail":"audit lift rides the trust schema","evidence":"docs/x.md:4","researched":"2026-10-19"}',
		]);
		run(["fact", "set", "finding.w836.plain", "plain text finding"]);

		// /api/data rides a 1.5s memo — wait it out so the seed is visible
		await sleep(1600);
		const d = (await (await fetch(`${BASE}/api/data`)).json()) as Row;
		const facts = (d.facts ?? []) as Row[];
		const demo = facts.find((f) => f.key === "lesson.w836.demo");
		expect(demo).toBeDefined();
		const trust = demo?.trust as Row;
		expect(trust?.rating).toBe("solid");
		expect(trust?.detail).toBe("audit lift rides the trust schema");
		expect(trust?.evidence).toBe("docs/x.md:4");
		expect(trust?.researched).toBe("2026-10-19");
		const plain = facts.find((f) => f.key === "finding.w836.plain");
		expect(plain?.trust ?? null).toBeNull();
		expect(typeof plain?.tsAgo).toBe("number");

		// the served page mounts the facts section (board-html body chunk)
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain('id="facts"');
		expect(page).toContain("renderFacts");
	});
});
