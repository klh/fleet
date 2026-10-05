// test/w224-catalog.test.ts — W224: the executor/model feed's belt half.
// catalogFor reads live /v1/models catalogs (dedupe + hostile-id filter),
// routeTask honors a --model override, route-to targets machine:port, and
// checkAll rows carry models[] — proven against a real stub endpoint (Bun
// .serve) and real CLI spawns with a scratch HOME, not mocks.
import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	catalogFor,
	type RemoteEndpoint,
	type RemoteMachine,
	routeTask,
	splitModelFlag,
} from "../bin/remotes.ts";

const ECHO_MODELS: string[] = ["m-a", "m-b", "m-a"]; // dup proves dedupe
const SEEN_AUTH: (string | null)[] = [];
const HOSTILE_MODELS: unknown[] = [
	"ok-id",
	"bad id", // whitespace — validModel rejects
	"",
	123, // not a string
	"x\ny", // control char — validModel rejects
];
const stub = Bun.serve({
	port: 0,
	fetch: async (req) => {
		const url = new URL(req.url);
		SEEN_AUTH.push(req.headers.get("authorization"));
		if (url.pathname === "/v1/models")
			return Response.json({ data: ECHO_MODELS.map((id) => ({ id })) });
		if (url.pathname === "/paas/models")
			return Response.json({ data: [{ id: "cloud-only" }] });
		if (url.pathname === "/v1/chat/completions") {
			const body = (await req.json()) as { model?: string };
			return Response.json({
				choices: [{ message: { content: `ECHO:${body.model ?? "?"}` } }],
			});
		}
		return new Response("nope", { status: 400 });
	},
});
const hostile = Bun.serve({
	port: 0,
	fetch: (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/models")
			return Response.json({ data: HOSTILE_MODELS.map((id) => ({ id })) });
		return new Response("nope", { status: 404 });
	},
});
const machine = (port: number): RemoteMachine => ({
	name: "w224stub",
	host: "stub.invalid",
	ip_fallback: "127.0.0.1",
	endpoints: [
		{ port, protocol: "openai", roles: ["general"], model: "m-default" },
	],
});
const ep = (port: number): RemoteEndpoint => ({
	port,
	protocol: "openai",
	roles: ["general"],
	model: "m-default",
});
const HOME = mkdtempSync(join(tmpdir(), "belt-w224-"));
afterAll(() => {
	stub.stop(true);
	hostile.stop(true);
	rmSync(HOME, { recursive: true, force: true });
});

test("catalogFor: live /v1/models, deduped, order kept", async () => {
	expect(await catalogFor(machine(stub.port), ep(stub.port))).toEqual([
		"m-a",
		"m-b",
	]);
});

test("catalogFor: hostile ids pass the validModel grammar or die", async () => {
	expect(await catalogFor(machine(hostile.port), ep(hostile.port))).toEqual([
		"ok-id",
	]);
});

test("catalogFor: cloud base + bearer rides auth, /models path", async () => {
	const cloud: RemoteEndpoint = {
		...ep(stub.port),
		base: `http://127.0.0.1:${stub.port}/paas`,
		api_key: "k-w224",
	};
	expect(await catalogFor(machine(stub.port), cloud)).toEqual(["cloud-only"]);
	expect(SEEN_AUTH.includes("Bearer k-w224")).toBe(true);
});

test("catalogFor: immich has none, dead port empty", async () => {
	expect(
		await catalogFor(machine(stub.port), {
			...ep(stub.port),
			protocol: "immich",
		}),
	).toEqual([]);
	expect(await catalogFor(machine(1), ep(1))).toEqual([]);
});

test("routeTask: default model, then --model override wins", async () => {
	expect(await routeTask(machine(stub.port), ep(stub.port), "hi")).toBe(
		"ECHO:m-default",
	);
	expect(await routeTask(machine(stub.port), ep(stub.port), "hi", "m-b")).toBe(
		"ECHO:m-b",
	);
});

test("splitModelFlag: splits, keeps valueless flag in the prompt", () => {
	expect(splitModelFlag(["a", "--model", "m", "b"])).toEqual({
		words: ["a", "b"],
		model: "m",
	});
	expect(splitModelFlag(["a", "--model", "b"])).toEqual({
		words: ["a"],
		model: "b",
	});
	expect(splitModelFlag(["a", "--model"])).toEqual({
		words: ["a", "--model"],
	});
	expect(splitModelFlag(["plain", "words"])).toEqual({
		words: ["plain", "words"],
	});
});

test("CLI route-to: targeted route with --model override (scratch HOME)", async () => {
	mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
	const cfg = {
		machines: [
			{
				name: "w224stub",
				host: "stub.invalid",
				ip_fallback: "127.0.0.1",
				endpoints: [ep(stub.port)],
			},
		],
	};
	writeFileSync(
		join(HOME, ".claude", "local-llm", "remotes.json"),
		JSON.stringify(cfg),
	);
	const cli = join(import.meta.dir, "..", "bin", "remotes.ts");
	const p = Bun.spawn(
		[
			process.execPath,
			cli,
			"route-to",
			"w224stub",
			String(stub.port),
			"--model",
			"m-b",
			"hello",
			"there",
		],
		{ env: { ...process.env, HOME }, stdout: "pipe", stderr: "pipe" },
	);
	const out = (await new Response(p.stdout).text()).trim();
	await p.exited;
	expect(p.exitCode).toBe(0);
	expect(out.endsWith("ECHO:m-b")).toBe(true);
});

test("route log: direct role + recorded override", () => {
	const log = readFileSync(
		join(HOME, ".claude", "local-llm", "remotes-routes.log"),
		"utf8",
	)
		.trim()
		.split("\n")
		.map(
			(l) =>
				JSON.parse(l) as {
					machine: string;
					role: string;
					model?: string;
					ok: boolean;
				},
		);
	const last = log.at(-1);
	expect(last?.machine).toBe("w224stub");
	expect(last?.role).toBe("direct");
	expect(last?.model).toBe("m-b");
	expect(last?.ok).toBe(true);
});

test("CLI route-to: unknown machine:port exits 1", async () => {
	const cli = join(import.meta.dir, "..", "bin", "remotes.ts");
	const p = Bun.spawn([process.execPath, cli, "route-to", "nope", "1", "hi"], {
		env: { ...process.env, HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	await new Response(p.stderr).text();
	await p.exited;
	expect(p.exitCode).toBe(1);
});

test("CLI check --json: rows carry the live models catalog", async () => {
	const cli = join(import.meta.dir, "..", "bin", "remotes.ts");
	const p = Bun.spawn([process.execPath, cli, "check", "--json"], {
		env: { ...process.env, HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(p.stdout).text();
	await p.exited;
	expect(p.exitCode).toBe(0);
	const rows = JSON.parse(out) as {
		machine: string;
		ok: boolean;
		models?: string[];
	}[];
	const mine = rows.find((r) => r.machine === "w224stub");
	expect(mine?.ok).toBe(true);
	expect(mine?.models).toEqual(["m-a", "m-b"]);
});
