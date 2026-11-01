// events-kit.e2e.ts — W2269.1.1: the typed event kit contract. bubbles +
// composed default true (cross shadow roots), static readonly type, typed
// readonly payload fields (never CustomEvent.detail), map augmentation so
// addEventListener is type-checked per domain.
import { expect, test } from "@playwright/test";
import {
	ThemeChanged,
	ThemeChangeRequested,
} from "../src/events/klh-theme.events.ts";

test.describe("typed event kit (W2269.1.1)", () => {
	test("base defaults: bubbles + composed @unit", () => {
		const ev = new ThemeChangeRequested("dark");
		expect(ev.type).toBe("theme-change-requested");
		expect(ev.bubbles).toBe(true);
		expect(ev.composed).toBe(true);
		expect(ev.theme).toBe("dark");
	});

	test("payload rides typed readonly fields, not detail @unit", () => {
		const ev = new ThemeChanged("light", "gear");
		expect(ev.type).toBe("theme-changed");
		expect(ev.theme).toBe("light");
		expect(ev.origin).toBe("gear");
		expect(ev.detail).toBeUndefined();
	});

	test("cancelable vetoes ride EventInit through the base @unit", () => {
		const ev = new ThemeChangeRequested("high-contrast", {
			cancelable: true,
		});
		expect(ev.cancelable).toBe(true);
		ev.preventDefault();
		expect(ev.defaultPrevented).toBe(true);
	});
});
