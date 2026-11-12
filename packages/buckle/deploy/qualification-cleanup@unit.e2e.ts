import { expect, test } from "@playwright/test";
import {
	createQualificationDriver,
	finishQualificationCleanup,
	type ProcessRunner,
} from "./test/qualification.ts";

test("cleanup failure retains the original API refusal and its own failure", async () => {
	const primary = Error("GET /v1/models status 403"),
		cleanup = Error("owned stop refused");
	let received: unknown;
	try {
		await finishQualificationCleanup(primary, async () => {
			throw cleanup;
		});
	} catch (error) {
		received = error;
	}
	expect(received).toBeInstanceOf(AggregateError);
	if (!(received instanceof AggregateError)) throw Error("missing aggregate");
	expect(received.errors).toEqual([primary, cleanup]);
	expect(received.message).toContain(primary.message);
	expect(received.message).toContain(cleanup.message);
});

test("running owned producer drains and naturally joins without a signal", async () => {
	const calls: string[][] = [];
	let inspections = 0;
	const run: ProcessRunner = async (argv) => {
		calls.push([...argv]);
		const out =
			argv[1] === "inspect"
				? JSON.stringify([
						{
							Id: "a".repeat(64),
							Config: { Labels: { "io.klh.seed.qualifier": "owned-run" } },
							State: { Running: ++inspections < 3, ExitCode: 0 },
						},
					])
				: argv[1] === "exec"
					? JSON.stringify({ drainStatus: 200 })
					: "";
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(out),
			stderr: new Uint8Array(),
		};
	};
	await createQualificationDriver(run, "owned-run").remove(
		"a".repeat(64),
		true,
	);
	expect(calls.map((argv) => argv[1])).toEqual([
		"inspect",
		"exec",
		"inspect",
		"inspect",
		"rm",
		"container",
	]);
	expect(calls[1]?.[2]).toBe("a".repeat(64));
	expect(calls[1]?.join(" ")).toContain("BUCKLE_ROOT_KEY");
	expect(calls[1]?.join(" ")).toContain("/v1/admin/drain");
});
