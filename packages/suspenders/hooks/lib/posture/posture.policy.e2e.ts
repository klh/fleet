import { expect, test } from "@playwright/test";
import { resolvePosture } from "./posture.resolve.ts";
import { selectPostureEntries } from "./posture.policy.ts";
import { postureDocument, postureLayer } from "./posture.fixtures.ts";

test("uses MUST placement when development override is disabled", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), []);
	const selected = selectPostureEntries(resolved, () => true);

	expect(selected.map((entry) => entry.policy)).toEqual(["MUST"]);
	expect(selected.map((entry) => entry.model)).toEqual(["coder"]);
});

test("an enabled override selects usable CAN entries without MUST spillover", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("repo/.prefer", {
			version: 1,
			selection: { developmentOverride: true },
		}),
	]);
	const selected = selectPostureEntries(
		resolved,
		(entry) => entry.model === "experiment",
	);

	expect(selected).toEqual([
		{
			hub: "example",
			model: "experiment",
			policy: "CAN",
			lanes: 2,
		},
	]);
});

test("returns to MUST when the enabled CAN set has no usable entry", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("repo/.prefer", {
			version: 1,
			selection: { developmentOverride: true },
		}),
	]);
	const selected = selectPostureEntries(
		resolved,
		(entry) => entry.policy === "MUST",
	);

	expect(selected.map((entry) => entry.policy)).toEqual(["MUST"]);
});

test("ignores OFF and zero rules and does not confuse capacity with usability", {
	tag: "@unit",
}, () => {
	const base = postureDocument();
	base.selection.developmentOverride = true;
	let configuredUsable = true;
	const runningLanes = 2;
	const laneCeiling = 2;
	const selected = selectPostureEntries(baseResolved(base), (entry) => {
		if (entry.policy !== "CAN") return false;
		return configuredUsable;
	});

	expect(runningLanes).toBe(laneCeiling);
	expect(selected.map((entry) => entry.model)).toEqual(["experiment"]);
	configuredUsable = false;
	expect(
		selectPostureEntries(
			baseResolved(base),
			(entry) => entry.policy === "MUST",
		).map((entry) => entry.policy),
	).toEqual(["MUST"]);
	expect(selectPostureEntries(baseResolved(base), () => false)).toEqual([]);
});

function baseResolved(document: ReturnType<typeof postureDocument>) {
	return resolvePosture(document, []);
}
