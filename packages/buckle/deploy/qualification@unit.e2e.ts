import { expect, test } from "@playwright/test";
import {
	createQualificationDriver,
	readHttp,
	type ProcessRunner,
} from "./test/qualification.ts";

test("qualification refuses a foreign container before stop/removal and retains private files", async () => {
	const calls: string[][] = [];
	const run: ProcessRunner = async (argv) => {
		calls.push([...argv]);
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(
				JSON.stringify([
					{
						Id: "a".repeat(64),
						Config: { Labels: { "io.klh.seed.qualifier": "foreign" } },
					},
				]),
			),
			stderr: new Uint8Array(),
		};
	};
	const driver = createQualificationDriver(run, "owned-run");
	await expect(driver.remove("a".repeat(64))).rejects.toThrow("ownership");
	expect(calls.every((argv) => argv[1] === "inspect")).toBe(true);
});

test("owned producer is stopped and joined before removal; failed stop prevents removal", async () => {
	const calls: string[][] = [];
	const run: ProcessRunner = async (argv, options) => {
		expect(options.timeoutMs).toBeGreaterThan(0);
		expect(options.maxBytes).toBeLessThanOrEqual(1024 * 1024);
		calls.push([...argv]);
		const out =
			argv[1] === "inspect"
				? [
						{
							Id: "a".repeat(64),
							Config: { Labels: { "io.klh.seed.qualifier": "owned-run" } },
							State: { Running: false, ExitCode: 0 },
						},
					]
				: [];
		return {
			code: argv[1] === "stop" ? 1 : 0,
			signal: null,
			stdout: Buffer.from(JSON.stringify(out)),
			stderr: new Uint8Array(),
		};
	};
	await expect(
		createQualificationDriver(run, "owned-run").remove("a".repeat(64)),
	).rejects.toThrow("Docker stop");
	expect(calls.map((argv) => argv[1])).toEqual(["inspect", "stop"]);
});

test("HTTP body deadline refuses a stalled body without awaiting cancel", async () => {
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				setTimeout(() => {
					try {
						controller.close();
					} catch {}
				}, 80);
			},
			cancel() {
				return new Promise(() => {});
			},
		}),
	);
	const started = performance.now();
	await expect(
		readHttp(
			"http://fixture.invalid",
			{},
			{ fetch: async () => response, timeoutMs: 20, maxBytes: 64 },
		),
	).rejects.toThrow("deadline");
	expect(performance.now() - started).toBeLessThan(500);
});

test("successful cleanup checks ownership, joins exit, removes full CID, and proves absence", async () => {
	const calls: string[] = [];
	const run: ProcessRunner = async (argv) => {
		calls.push(argv[1] ?? "");
		const out =
			argv[1] === "inspect"
				? JSON.stringify([
						{
							Id: "a".repeat(64),
							Config: { Labels: { "io.klh.seed.qualifier": "owned-run" } },
							State: { Running: false, ExitCode: 0 },
						},
					])
				: "";
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(out),
			stderr: new Uint8Array(),
		};
	};
	await createQualificationDriver(run, "owned-run").remove("a".repeat(64));
	expect(calls).toEqual(["inspect", "stop", "inspect", "rm", "container"]);
});

test("a still-running producer refuses removal despite stop exit zero", async () => {
	const calls: string[] = [];
	const run: ProcessRunner = async (argv) => {
		calls.push(argv[1] ?? "");
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(
				JSON.stringify([
					{
						Id: "a".repeat(64),
						Config: { Labels: { "io.klh.seed.qualifier": "owned-run" } },
						State: { Running: true, ExitCode: 0 },
					},
				]),
			),
			stderr: new Uint8Array(),
		};
	};
	await expect(
		createQualificationDriver(run, "owned-run").remove("a".repeat(64)),
	).rejects.toThrow("join cleanly");
	expect(calls).toEqual(["inspect", "stop", "inspect"]);
});

test("HTTP refuses oversize output and a headers fetch ignoring abort", async () => {
	await expect(
		readHttp(
			"http://fixture.invalid",
			{},
			{
				fetch: async () => new Response("x".repeat(65)),
				timeoutMs: 100,
				maxBytes: 64,
			},
		),
	).rejects.toThrow("byte bound");
	await expect(
		readHttp(
			"http://fixture.invalid",
			{},
			{
				fetch: () =>
					new Promise((resolve) =>
						setTimeout(() => resolve(new Response("late")), 80),
					),
				timeoutMs: 20,
				maxBytes: 64,
			},
		),
	).rejects.toThrow("deadline");
});

test("uncertain-create recovery checks exact UUID label and full CID before cleanup", async () => {
	const calls: string[][] = [];
	const run: ProcessRunner = async (argv) => {
		calls.push([...argv]);
		return {
			code: 0,
			signal: null,
			stdout: Buffer.from(
				JSON.stringify([
					{
						Id: "b".repeat(64),
						Config: { Labels: { "io.klh.seed.qualifier": "owned-run" } },
					},
				]),
			),
			stderr: new Uint8Array(),
		};
	};
	expect(
		await createQualificationDriver(run, "owned-run").recoverCreated(),
	).toBe("b".repeat(64));
	expect(calls.map((argv) => argv[2])).toEqual([
		"buckle-qualifier-owned-run",
		"b".repeat(64),
	]);
});
