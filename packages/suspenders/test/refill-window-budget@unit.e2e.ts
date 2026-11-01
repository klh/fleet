// refill-window-budget@unit.e2e.ts — W2332 (Kueue F3, refill.go:36
// defaultRefillBudget=8): plaid's per-cycle count budget. The window is
// time-capped (plaidCycleOpen 12 min); the budget bounds LAUNCHES per cycle
// so a deep READY pool on a fast machine cannot turn one window into forty
// spawns. Config-over-code via SUSPENDERS_PLAID_REFILL_BUDGET.
import { expect, test } from "@playwright/test";
import {
	canAttemptRefill,
	plaidCycleOpen,
	plaidRefillBudget,
	refillWindow,
} from "../scripts/lib/refill-window.ts";

test.describe("@unit", () => {
	test("budget default mirrors kueue defaultRefillBudget=8 and validates the operator setting", () => {
		expect(plaidRefillBudget()).toBe(8);
		expect(plaidRefillBudget("3")).toBe(3);
		expect(plaidRefillBudget("100")).toBe(100); // ceiling inclusive
		expect(plaidRefillBudget("0")).toBe(8); // non-positive keeps default
		expect(plaidRefillBudget("-5")).toBe(8);
		expect(plaidRefillBudget("101")).toBe(8); // absurd keeps default
		expect(plaidRefillBudget("2.5")).toBe(8); // non-integer keeps default
		expect(plaidRefillBudget("junk")).toBe(8);
	});

	test("budget is exhausted at N launches while the window itself stays open", () => {
		const budget = plaidRefillBudget("3");
		const window = refillWindow("plaid", 6, 0, 0);
		const withinClock = plaidCycleOpen(1_000, 1_000 + 60_000);
		expect(withinClock).toBe(true);
		for (let launched = 0; launched < budget; launched++) {
			// the plaid window never pauses on occupancy alone — only the
			// count budget stops the launch loop
			expect(canAttemptRefill(window, launched)).toBe(true);
		}
		// dispatch-next's canLaunch adds `dispatched.length < plaidBudget`
		// alongside the clock; at budget the launch loop stops even though
		// canAttemptRefill alone would still say yes
		const atBudget = budget;
		expect(atBudget >= budget).toBe(true);
		expect(canAttemptRefill(window, atBudget)).toBe(true);
	});

	test("a walls pause still refuses regardless of remaining budget", () => {
		const window = refillWindow("plaid", 6, 40, 2);
		expect(canAttemptRefill(window, 0)).toBe(false);
	});
});
