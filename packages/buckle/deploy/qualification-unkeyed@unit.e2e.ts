import { expect, test } from "@playwright/test";
import {
	disposeUnkeyed,
	qualifyUnkeyed,
	type DisposalIntent,
} from "./test/qualification-unkeyed.ts";

const id = "a".repeat(64),
	runId = "11111111-1111-4111-8111-111111111111";
const controls = {
	mode: "unkeyed",
	catalogStatus: 401,
	completionStatus: 401,
	upstreamRequestDelta: 0,
	requestCounter: "all-upstream-requests",
};
const image =
	"ghcr.io/klh/fleet/buckle-seed@sha256:b57ec30f3582d298f4b465d3a8cd629ab3447b3b644dd26efde5a4cb0a062189";

test("ordinary cleanup still refuses exit137 without an unkeyed disposal intent", async () => {
	const { createQualificationDriver } = await import("./test/qualification.ts");
	const operations: string[] = [];
	const driver = createQualificationDriver(async (argv) => {
		operations.push(argv[1] ?? "");
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(
				argv[1] === "inspect"
					? JSON.stringify([
							{
								Id: id,
								Config: { Labels: { "io.klh.seed.qualifier": runId } },
								State: { Running: false, ExitCode: 137 },
							},
						])
					: "",
			),
			stderr: new Uint8Array(),
		};
	}, runId);
	await expect(driver.remove(id)).rejects.toThrow("did not join cleanly");
	expect(operations).toEqual(["inspect", "stop", "inspect"]);
});

for (const scenario of ["pass", "wrongstatus", "outbound"] as const)
	test(`unkeyed HTTP controls ${scenario}`, async () => {
		let count = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				if (scenario === "outbound") count++;
				return new Response(null, {
					status: scenario === "wrongstatus" ? 200 : 401,
				});
			},
		});
		try {
			const action = () =>
				qualifyUnkeyed(
					`http://127.0.0.1:${server.port}`,
					() => count,
					() => {},
				);
			if (scenario === "pass") expect(await action()).toEqual(controls);
			else await expect(action()).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});

for (const scenario of [
	"pass",
	"predead",
	"preid",
	"preimage",
	"preexit137",
	"postmissing",
	"postid",
	"preoom",
	"foreign",
	"missing",
	"stopfail",
	"postrunning",
	"postoom",
	"postexit0",
	"postforeign",
	"absence",
	"badcontrols",
] as const)
	test(`unkeyed explicit disposal ${scenario}`, async () => {
		const events: string[] = [],
			intents: DisposalIntent[] = [];
		let inspections = 0;
		const docker = async (argv: readonly string[], timeoutMs = 10000) => {
			events.push(argv[0] ?? "");
			if (argv[0] === "inspect") {
				inspections++;
				const pre = inspections === 1;
				return JSON.stringify([
					{
						Id:
							(scenario === "preid" && pre) || (scenario === "postid" && !pre)
								? "b".repeat(64)
								: id,
						Config: {
							Image: scenario === "preimage" && pre ? "foreign-image" : image,
							Labels: {
								"io.klh.seed.qualifier":
									scenario === "foreign" || (scenario === "postforeign" && !pre)
										? "foreign"
										: runId,
							},
						},
						...(scenario === "missing" || (scenario === "postmissing" && !pre)
							? {}
							: {
									State: {
										Running: pre
											? scenario !== "predead"
											: scenario === "postrunning",
										ExitCode: pre
											? scenario === "preexit137"
												? 137
												: 0
											: scenario === "postexit0"
												? 0
												: 137,
										OOMKilled: pre
											? scenario === "preoom"
											: scenario === "postoom",
									},
								}),
					},
				]);
			}
			if (argv[0] === "stop") {
				expect(events.at(-2)).toBe("intent");
				expect(argv).toEqual(["stop", "--time", "5", id]);
				expect(timeoutMs).toBe(8000);
				if (scenario === "stopfail") throw Error("stop refused");
			}
			return argv[0] === "container" && scenario === "absence" ? id : "";
		};
		const action = () =>
			disposeUnkeyed(
				docker,
				{
					id,
					runId,
					controls:
						scenario === "badcontrols"
							? { ...controls, upstreamRequestDelta: 1 }
							: controls,
				},
				(fact) => {
					intents.push(fact);
					events.push("intent");
				},
			);
		if (scenario === "pass") {
			expect(await action()).toMatchObject({
				graceful: false,
				expectedForcedDisposal: true,
				preintentRunningVerified: true,
				observedExitCode: 137,
				removedAndAbsent: id,
			});
			expect(events).toEqual([
				"inspect",
				"intent",
				"stop",
				"inspect",
				"rm",
				"container",
			]);
			expect(intents[0]?.argv).toEqual(["docker", "stop", "--time", "5", id]);
		} else {
			await expect(action()).rejects.toThrow();
			if (
				[
					"predead",
					"preid",
					"preimage",
					"preexit137",
					"preoom",
					"foreign",
					"missing",
					"badcontrols",
				].includes(scenario)
			)
				expect(events).not.toContain("stop");
			if (scenario !== "absence") expect(events).not.toContain("rm");
		}
	});
