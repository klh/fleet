import { expect, test } from "bun:test";
import { stableDescendant } from "./owned-process.ts";
const birth = (pid: number) => ({ birth: String(pid), command: "worker" });
test("bounded ancestry accepts nested worker children", () => {
	expect(
		stableDescendant(30, 10, {
			birth,
			parent: (pid) => (pid === 30 ? 20 : 10),
		}),
	).toBe("owned");
});
test("cycles and depth overflow never establish ownership", () => {
	expect(stableDescendant(30, 10, { birth, parent: () => 30 })).toBe(
		"unrelated",
	);
	expect(stableDescendant(30, 10, { birth, parent: (pid) => pid - 1 })).toBe(
		"unrelated",
	);
});
test("intermediate ancestor reuse fails the whole ownership proof", () => {
	let reads = 0;
	expect(
		stableDescendant(30, 10, {
			birth: (pid) =>
				pid === 20 && ++reads > 1
					? { birth: "reused", command: "worker" }
					: birth(pid),
			parent: (pid) => (pid === 30 ? 20 : 10),
		}),
	).toBe("unknown");
});
