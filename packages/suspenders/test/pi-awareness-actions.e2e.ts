import { expect, test } from "@playwright/test";

test("Pi consult verifies both actor and expert then sends literal argv @unit", async () => {
	const { executeAction } = await import(
		"../pi-extensions/fleet-awareness/actions.ts"
	);
	const calls: string[][] = [];
	const question = 'inspect $(do-not-run) and "quotes"';
	const run = async (_command: string, args: string[]) => {
		calls.push(args);
		return {
			stdout:
				args[0] === "targets"
					? JSON.stringify([
							{
								sid: "pi-fixture",
								label: "self",
								sessionName: "self",
								capabilities: [],
							},
							{
								sid: "expert-fixture",
								label: "expert",
								sessionName: "fleet",
								capabilities: [],
							},
						])
					: "CONSULT C1 -> expert-fixture",
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	};
	const result = await executeAction(
		{ action: "consult", target: "fleet", question },
		run,
		"/fixture",
		"fixture",
	);
	expect(result.state).toBe("queued");
	expect(calls[1]).toEqual([
		"consult",
		"expert-fixture",
		question,
		"--as",
		"pi-fixture",
	]);
	expect(calls).toHaveLength(2);
	await expect(
		executeAction(
			{ action: "consult", target: "missing", question },
			run,
			"/fixture",
			"fixture",
		),
	).rejects.toThrow("expert");
	expect(calls.filter((args) => args[0] === "consult")).toHaveLength(1);
});

test("Pi actions refuse ambiguous actors and option-shaped input before writes @unit", async () => {
	const { executeAction } = await import(
		"../pi-extensions/fleet-awareness/actions.ts"
	);
	const calls: string[][] = [];
	const run = async (_command: string, args: string[]) => {
		calls.push(args);
		return {
			stdout: JSON.stringify(
				["fixture", "pi-fixture"].map((sid) => ({
					sid,
					label: sid,
					sessionName: null,
					capabilities: [],
				})),
			),
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	};
	await expect(
		executeAction(
			{ action: "ack", event: 42, acted: "read it" },
			run,
			"/fixture",
			"fixture",
		),
	).rejects.toThrow("identity");
	expect(calls).toEqual([["targets", "--json"]]);
	await expect(
		executeAction({ action: "item", id: "--help" }, run, "/fixture", null),
	).rejects.toThrow();
	await expect(
		executeAction(
			{ action: "knowledge", query: "--json" },
			run,
			"/fixture",
			null,
		),
	).rejects.toThrow();
	expect(calls).toHaveLength(1);
});

test("Pi replies feedback and acknowledgments preserve attribution and literal argv @unit", async () => {
	const { executeAction } = await import(
		"../pi-extensions/fleet-awareness/actions.ts"
	);
	const calls: string[][] = [];
	const run = async (_command: string, args: string[]) => {
		calls.push(args);
		return {
			stdout:
				args[0] === "targets"
					? JSON.stringify([
							{
								sid: "fixture",
								label: "self",
								sessionName: null,
								capabilities: [],
							},
						])
					: "recorded",
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	};
	for (const action of [
		{
			action: "reply",
			consult: "C12",
			answer: "$(literal)",
			version: "abc123",
		},
		{
			action: "feedback",
			consult: "C12",
			outcome: "resolved",
			evidence: "tested",
		},
		{ action: "ack", event: 42, acted: "read" },
	]) {
		expect(
			(await executeAction(action, run, "/fixture", "fixture")).state,
		).toBe("ok");
	}
	expect(calls.filter((a) => a[0] !== "targets")).toEqual([
		[
			"consult-reply",
			"C12",
			"$(literal)",
			"--as",
			"fixture",
			"--version",
			"abc123",
		],
		[
			"consult-reply",
			"C12",
			"--feedback",
			"resolved",
			"--evidence",
			"tested",
			"--as",
			"fixture",
		],
		["ack", "42", "--as", "fixture"],
	]);
});

test("Pi refuses option-shaped peer SIDs from control-plane output @unit", async () => {
	const { executeAction } = await import(
		"../pi-extensions/fleet-awareness/actions.ts"
	);
	const calls: string[][] = [];
	const run = async (_command: string, args: string[]) => {
		calls.push(args);
		return {
			stdout:
				args[0] === "targets"
					? JSON.stringify([
							{
								sid: "fixture",
								label: "self",
								sessionName: null,
								capabilities: [],
							},
							{
								sid: "--help",
								label: "expert",
								sessionName: "fleet",
								capabilities: [],
							},
						])
					: "recorded",
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	};
	await expect(
		executeAction(
			{ action: "consult", target: "fleet", question: "inspect" },
			run,
			"/fixture",
			"fixture",
		),
	).rejects.toThrow();
	expect(calls).toEqual([["targets", "--json"]]);
});
