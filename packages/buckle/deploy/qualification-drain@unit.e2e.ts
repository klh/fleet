import { expect, test } from "@playwright/test";
import {
	createQualificationDriver,
	type ProcessRunner,
} from "./test/qualification.ts";

for (const failure of ["401", "timeout", "stop", "foreign", "exit137"] as const)
	test(`drain ${failure} refuses success while attempting only ownership-verified bounded cleanup`, async () => {
		const calls: string[][] = [];
		let stopped = false;
		const run: ProcessRunner = async (argv, options) => {
			calls.push([...argv]);
			expect(options.timeoutMs).toBeLessThanOrEqual(10000);
			if (argv[1] === "exec" && failure !== "401")
				throw Error("drain deadline");
			if (argv[1] === "stop") {
				if (failure === "stop")
					return {
						code: 1,
						signal: null,
						stdout: new Uint8Array(),
						stderr: new Uint8Array(),
					};
				stopped = true;
			}
			const output =
				argv[1] === "inspect"
					? JSON.stringify([
							{
								Id: "a".repeat(64),
								Config: {
									Labels: {
										"io.klh.seed.qualifier":
											failure === "foreign" && calls.length > 1
												? "foreign"
												: "owned-run",
									},
								},
								State: {
									Running: !stopped,
									ExitCode: stopped && failure === "exit137" ? 137 : 0,
								},
							},
						])
					: argv[1] === "exec"
						? JSON.stringify({ drainStatus: 401 })
						: "";
			return {
				code: 0,
				signal: null,
				stdout: Buffer.from(output),
				stderr: new Uint8Array(),
			};
		};
		let refusal: unknown;
		try {
			await createQualificationDriver(run, "owned-run").remove(
				"a".repeat(64),
				true,
			);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(Error);
		const operations = calls.map((argv) => argv[1]);
		if (failure === "foreign") {
			expect(operations).not.toContain("stop");
			expect(operations).not.toContain("rm");
		} else {
			expect(operations).toContain("stop");
			expect(calls.find((argv) => argv[1] === "stop")?.at(-1)).toBe(
				"a".repeat(64),
			);
			if (failure === "stop" || failure === "exit137") {
				expect(operations).not.toContain("rm");
				expect(refusal).toBeInstanceOf(AggregateError);
				expect(String(refusal)).toContain("drain deadline");
				expect(String(refusal)).toContain(
					failure === "stop" ? "Docker stop failed" : "exit=137",
				);
			} else expect(operations.slice(-2)).toEqual(["rm", "container"]);
		}
	});
