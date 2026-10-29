// hooks/board-html/feed-ages.e2e.ts — client-side age derivation: a 304
// keeps the last body, stampAges re-derives every relative age from its
// absolute stamp and slides the observation window, and the embedded copy
// in CORE is the same function.
import { expect, test } from "@playwright/test";
import { CORE } from "./core.ts";
import { stampAges } from "./feed-ages.ts";

const now = 1_000_000_000;

test.describe("@unit", () => {
	test("every *Ago / age_s is recomputed from its stamp", () => {
		const j = {
			ts: now - 60_000,
			observation: { observedAt: now - 60_000, expiresAt: now - 55_000 },
			sessions: [{ sid: "a", hb: now - 30_000, hbAgo: 0 }],
			claims: [{ ts: now - 5_000, tsAgo: 0 }],
			events: [{ ts: now - 120_000, tsAgo: 0 }],
			facts: [{ ts: now - 1_000, tsAgo: 0 }],
			inbox: [{ ts: now, tsAgo: 9 }],
			tasks: [
				{ updated_at_utc: new Date(now - 90_000).toISOString(), age_s: 0 },
			],
			decisions: [{ created_ts: now - 7_000, age_s: 0 }],
			projects: [
				{ project: "p", done: [{ updatedAt: now - 3_000, updatedAgo: 0 }] },
			],
		};
		stampAges(j, now);
		expect(j.sessions[0].hbAgo).toBe(30);
		expect(j.claims[0].tsAgo).toBe(5);
		expect(j.events[0].tsAgo).toBe(120);
		expect(j.facts[0].tsAgo).toBe(1);
		expect(j.inbox[0].tsAgo).toBe(0);
		expect(j.tasks[0].age_s).toBe(90);
		expect(j.decisions[0].age_s).toBe(7);
		expect(j.projects[0].done[0].updatedAgo).toBe(3);
		expect(j.observation).toEqual({ observedAt: now, expiresAt: now + 5_000 });
	});

	test("missing or zero stamps render unknown (-1), like the server's ago()", () => {
		const j = {
			sessions: [
				{ hb: 0, hbAgo: 4 },
				{ hb: null, hbAgo: 4 },
			],
		};
		stampAges(j, now);
		expect(j.sessions.map((s) => s.hbAgo)).toEqual([-1, -1]);
	});

	test("non-object payloads pass through untouched", () => {
		expect(stampAges(null, now)).toBeNull();
		expect(stampAges("x", now)).toBe("x");
	});

	test("CORE embeds a parseable stampAges with the skew-corrected restamp", () => {
		const src =
			CORE.match(/function stampAges[\s\S]*?\nfunction restamp[^\n]*/)?.[0] ??
			"";
		expect(src).toContain("function restamp(j)");
		const fn = new Function(`${src}; return stampAges;`)();
		const j = { claims: [{ ts: now - 2_000, tsAgo: 0 }] };
		fn(j, now);
		expect(j.claims[0].tsAgo).toBe(2);
	});
});
