import { expect, test } from "bun:test";
import { observation, observationFresh } from "./observation.ts";

test("cached evidence preserves its observation time and expires without changing target state", () => {
	const evidence = observation(
		"network-probe",
		"http://service/health",
		"local",
		1000,
		100,
		"http-check",
	);
	expect(observationFresh(evidence, 1099)).toBe(true);
	expect(observationFresh(evidence, 1100)).toBe(false);
	expect(evidence.observedAt).toBe(1000);
	expect(evidence.target).toBe("http://service/health");
});
test("invalid or future evidence cannot establish a current verdict", () => {
	expect(observationFresh(null)).toBe(false);
	expect(
		observationFresh(
			observation("probe", "target", "local", 10_000, 100, "tcp"),
			1000,
		),
	).toBe(false);
	expect(
		observationFresh(
			{
				...observation("probe", "target", "local", 1000, 100, "tcp"),
				expiresAt: Number.NaN,
			},
			1000,
		),
	).toBe(false);
	expect(() =>
		observation("probe", "target", "local", 1000, 0, "tcp"),
	).toThrow();
});
