// W1013 — the WS-native ChatGPT auto-coordinate loop: trigger filter, dedupe,
// brief composer and the W931 ingress POST shape (in-process stub server —
// the hub-wire-test lesson: async fetch answers in-process; never spawnSync).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeBrief,
	createBoardWire,
	createChatGptCoordinator,
	emptyState,
	ikeaContaminated,
	loadChatGptCoordConfig,
	loadState,
	scanTriggers,
	saveState,
	type ChatGptCoordConfig,
	type ConsultWire,
	type Trigger,
} from "../hooks/lib/chatgpt-coordinate.ts";
import { openMemoryStore } from "../hooks/lib/govdb-store.ts";

const scratch = (): string => {
	const dir = join(tmpdir(), `w1013-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const seedStore = (
	rows: {
		id: number;
		kind: string;
		scope?: string | null;
		payload?: string | null;
	}[],
) => {
	const store = openMemoryStore();
	store.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	for (const r of rows)
		store.run(
			"INSERT INTO events (id, ts, source, kind, scope, payload) VALUES (?, ?, 'test', ?, ?, ?)",
			r.id,
			1,
			r.kind,
			r.scope ?? null,
			r.payload ?? null,
		);
	return store;
};

const cfg = (over: Partial<ChatGptCoordConfig> = {}): ChatGptCoordConfig => ({
	enabled: true,
	target: "",
	boardUrl: "http://127.0.0.1:7799",
	writeTokenFile: "/no/such/token",
	askerSid: "chatgpt-auto",
	dedupeS: 3600,
	failedRelaunches: 2,
	briefMaxLines: 80,
	triggers: { needDecision: true, failedRelaunch: true, benchRow: true },
	...over,
});

const stubWire = (log: string[]): ConsultWire => ({
	postConsult: async (body) => {
		log.push(`ask:${JSON.stringify(body)}`);
		return { status: 200, json: { ok: true, consult: `C${log.length}` } };
	},
	fetchOutbox: async () => ({ status: 200, json: { events: [] } }),
	closeFeedback: async (consult, feedback, evidence) => {
		log.push(`feedback:${consult}:${feedback}:${evidence.slice(0, 40)}`);
	},
	relayAnswer: async (consult, answer, itemId) => {
		log.push(`relay:${consult}:${itemId ?? "-"}:${answer.slice(0, 30)}`);
		return itemId ? "relayed" : "skipped";
	},
});

describe("W1013 config", () => {
	test("no config file = null (the runner idles)", () => {
		expect(
			loadChatGptCoordConfig("/no/such/chatgpt-coordinate.yaml"),
		).toBeNull();
	});

	test("machine json keys map over the defaults", () => {
		const dir = scratch();
		dirs.push(dir);
		const path = join(dir, "chatgpt-coordinate.json");
		writeFileSync(
			path,
			JSON.stringify({
				enabled: true,
				target: "chatgpt-agent",
				board_url: "http://b.local:7799",
				asker_sid: "cg-auto",
				dedupe_s: 60,
				failed_relaunches: 3,
				brief_max_lines: 40,
				triggers: {
					need_decision: true,
					failed_relaunch: false,
					bench_row: false,
				},
			}),
		);
		const c = loadChatGptCoordConfig(path);
		expect(c?.enabled).toBe(true);
		expect(c?.target).toBe("chatgpt-agent");
		expect(c?.boardUrl).toBe("http://b.local:7799");
		expect(c?.askerSid).toBe("cg-auto");
		expect(c?.dedupeS).toBe(60);
		expect(c?.failedRelaunches).toBe(3);
		expect(c?.briefMaxLines).toBe(40);
		expect(c?.triggers.failedRelaunch).toBe(false);
	});

	test("IKEA guard is textual and case-insensitive", () => {
		expect(ikeaContaminated("IKEA hub layout")).toBe(true);
		expect(ikeaContaminated(null, "clean detail")).toBe(false);
	});
});

describe("W1013 trigger filter", () => {
	const scan = (
		rows: Parameters<typeof seedStore>[0],
		state = emptyState(),
	) => {
		const store = seedStore(rows);
		try {
			return triggerScan(store, state);
		} finally {
			store.close();
		}
	};
	const triggerScan = (
		store: ReturnType<typeof seedStore>,
		state = emptyState(),
	) =>
		scanTriggers(store, {
			project: "/repo",
			config: cfg(),
			state,
			repo: "/repo",
			revParse: () => null,
			changedPaths: () => [],
		});

	test("NEED_DECISION events become asks with the item scope", () => {
		const t = scan([
			{
				id: 1,
				kind: "NEED_DECISION",
				scope: "W500",
				payload: '{"reason":"merge conflict needs owner"}',
			},
		]);
		expect(t.length).toBe(1);
		expect(t[0]?.cls).toBe("need-decision");
		expect(t[0]?.itemId).toBe("W500");
		expect(t[0]?.identity).toBe("need-decision:1");
	});

	test("IKEA-scoped NEED_DECISION never triggers", () => {
		const t = scan([
			{
				id: 2,
				kind: "NEED_DECISION",
				scope: null,
				payload: '{"reason":"IKEA hub cutover needs owner"}',
			},
		]);
		expect(t).toEqual([]);
	});

	test("failed-relaunch fires at the >=2 milestone, per failure count", () => {
		const t = scan([
			{
				id: 1,
				kind: "work.failed",
				payload: '{"work":"W600","project":"/repo","note":"boom"}',
			},
			{
				id: 2,
				kind: "work.failed",
				payload: '{"work":"W600","project":"/repo","note":"boom again"}',
			},
		]);
		expect(t.length).toBe(1);
		expect(t[0]?.identity).toBe("failed-relaunch:W600:2");
	});

	test("a single failure and other projects stay quiet", () => {
		const t = scan([
			{
				id: 1,
				kind: "work.failed",
				payload: '{"work":"W600","project":"/repo"}',
			},
			{
				id: 2,
				kind: "work.failed",
				payload: '{"work":"W601","project":"/other","note":"nope"}',
			},
		]);
		expect(t).toEqual([]);
	});

	test("bench row fires on a benchmarks.md change at a new head", () => {
		const store = seedStore([]);
		const state = emptyState();
		const t = scanTriggers(store, {
			project: "/repo",
			config: cfg(),
			state,
			repo: "/repo",
			revParse: () => "abc123def456",
			changedPaths: () => ["benchmarks.md", "README.md"],
		});
		store.close();
		expect(t.length).toBe(1);
		expect(t[0]?.cls).toBe("bench-row");
		expect(state.benchHead).toBe("abc123def456");
	});

	test("bench row is silent when benchmarks.md did not change", () => {
		const store = seedStore([]);
		const t = scanTriggers(store, {
			project: "/repo",
			config: cfg(),
			state: emptyState(),
			repo: "/repo",
			revParse: () => "abc123def456",
			changedPaths: () => ["README.md"],
		});
		store.close();
		expect(t).toEqual([]);
	});
});

describe("W1013 brief composer", () => {
	const trigger: Trigger = {
		cls: "need-decision",
		identity: "need-decision:9",
		itemId: "W500",
		subject: "decision needed on W500",
		// synthetic key material, proves the brief mask pass
		detail:
			"key sk-abc123DEF456ghi789JKLMNOPQ in log\ntokens sk-xyz in payload", // scrub:allow synthetic
	};

	test("bounded, item-scoped, ends with the verdict ask", () => {
		const brief = composeBrief(trigger, {
			itemTitle: "Do the thing",
			itemState: "FAILED",
			maxLines: 80,
		});
		const lines = brief.split("\n");
		expect(lines.length).toBeLessThanOrEqual(80);
		expect(lines.some((l) => l.includes("W500"))).toBe(true);
		expect(brief).toContain("per-item verdict for W500");
		expect(lines[lines.length - 1]?.startsWith("reply with")).toBe(true);
	});

	test("secret material is masked before the brief exists", () => {
		const brief = composeBrief(trigger, {});
		expect(brief).not.toContain("sk-abc123DEF456ghi789"); // scrub:allow synthetic
		expect(brief).toContain("[redacted]");
	});

	test("the maxLines cap is honored", () => {
		const long: Trigger = {
			...trigger,
			detail: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
		};
		const brief = composeBrief(long, { maxLines: 80 });
		expect(brief.split("\n").length).toBe(80);
	});
});

describe("W1013 coordinator loop", () => {
	test("disabled config and the paused marker short-circuit", async () => {
		const dir = scratch();
		dirs.push(dir);
		const wire = stubWire([]);
		const runOff = createChatGptCoordinator({
			config: cfg({ enabled: false }),
			project: "/repo",
			repo: dir,
			statePath: join(dir, "state.json"),
			wire,
			store: seedStore([]),
		});
		expect((await runOff()).status).toBe("disabled");
		mkdirSync(join(dir, ".fleet"), { recursive: true });
		writeFileSync(join(dir, ".fleet", "chatgpt-auto-paused"), "");
		const runPaused = createChatGptCoordinator({
			config: cfg(),
			project: "/repo",
			repo: dir,
			statePath: join(dir, "state.json"),
			wire,
			store: seedStore([]),
		});
		expect((await runPaused()).status).toBe("paused");
		expect(wire === null).toBe(false);
	});

	test("identity dedupe: one ask per identity inside the window", async () => {
		const dir = scratch();
		dirs.push(dir);
		const log: string[] = [];
		const wire = stubWire(log);
		const store = seedStore([
			{
				id: 1,
				kind: "NEED_DECISION",
				scope: "W500",
				payload: '{"reason":"needs owner"}',
			},
		]);
		const deps = {
			config: cfg(),
			project: "/repo",
			repo: dir,
			statePath: join(dir, "state.json"),
			wire,
			store,
			itemInfo: () => ({ title: "T", state: "FAILED" }),
			now: () => 1000,
		};
		const first = await createChatGptCoordinator(deps)();
		expect(first.asked.length).toBe(1);
		// a NEED_DECISION stays live: the newest-window re-yield is governed
		// by the identity ledger, so the same signal dedupes inside the window
		const second = await createChatGptCoordinator(deps)();
		expect(second.asked.length).toBe(0);
		expect(second.deduped).toEqual(["need-decision:1"]);
		// past the window the unresolved signal re-asks (the hourly cadence)
		const later = await createChatGptCoordinator({
			...deps,
			now: () => 1000 + 3600_000,
		})();
		expect(later.asked.length).toBe(1);
		store.close();
		// the POST body rides the W931 shape
		const body = JSON.parse(log[0]?.slice("ask:".length) ?? "{}") as Record<
			string,
			unknown
		>;
		expect(body.project).toBe("/repo");
		expect(body.sid).toBe("chatgpt-auto");
		expect(body.best).toBe(true);
		expect(body.scope).toBe("W500");
		expect(String(body.q).split("\n").length).toBeLessThanOrEqual(80);
	});

	test("a configured target rides target instead of best", async () => {
		const dir = scratch();
		dirs.push(dir);
		const log: string[] = [];
		const wire = stubWire(log);
		const store = seedStore([
			{
				id: 1,
				kind: "NEED_DECISION",
				scope: "W500",
				payload: '{"reason":"needs owner"}',
			},
		]);
		await createChatGptCoordinator({
			config: cfg({ target: "chatgpt-agent" }),
			project: "/repo",
			repo: dir,
			statePath: join(dir, "state.json"),
			wire,
			store,
		})();
		store.close();
		const body = JSON.parse(log[0]?.slice("ask:".length) ?? "{}") as Record<
			string,
			unknown
		>;
		expect(body.target).toBe("chatgpt-agent");
		expect(body.best).toBeUndefined();
	});

	test("drain: consult.answer flows to the item and closes with feedback", async () => {
		const dir = scratch();
		dirs.push(dir);
		const log: string[] = [];
		const statePath = join(dir, "state.json");
		// pre-seed an open consult as if a prior fire asked it
		const prior = emptyState();
		prior.open.C7 = { identity: "need-decision:1", itemId: "W500", ts: 0 };
		saveState(statePath, prior);
		const store = seedStore([]);
		const out = await createChatGptCoordinator({
			config: cfg(),
			project: "/repo",
			repo: dir,
			statePath,
			wire: {
				...stubWire(log),
				fetchOutbox: async () => ({
					status: 200,
					json: {
						events: [
							{
								kind: "consult.answer",
								payload:
									'{"consult":"C7","state":"ANSWERED","answer":"split the item"}',
							},
						],
					},
				}),
			},
			store,
		})();
		store.close();
		expect(out.drained).toEqual([{ consult: "C7", relay: "relayed" }]);
		expect(log.some((l) => l.startsWith("relay:C7:W500:"))).toBe(true);
		expect(log.some((l) => l.startsWith("feedback:C7:resolved:"))).toBe(true);
		expect(Object.keys(loadState(statePath).open)).toEqual([]);
	});

	test("wire errors collect, never throw", async () => {
		const dir = scratch();
		dirs.push(dir);
		const store = seedStore([
			{
				id: 1,
				kind: "NEED_DECISION",
				scope: "W500",
				payload: '{"reason":"needs owner"}',
			},
		]);
		const out = await createChatGptCoordinator({
			config: cfg(),
			project: "/repo",
			repo: dir,
			statePath: join(dir, "state.json"),
			wire: {
				...stubWire([]),
				postConsult: async () => ({
					status: 502,
					json: { ok: false, output: "down" },
				}),
			},
			store,
		})();
		store.close();
		expect(out.asked).toEqual([]);
		expect(out.errors.length).toBe(1);
	});
});

describe("W1013 ingress POST shape (in-process board stub)", () => {
	test("createBoardWire sends the token header and parses the reply", async () => {
		const dir = scratch();
		dirs.push(dir);
		const tokenFile = join(dir, "write-token");
		writeFileSync(tokenFile, "tok-123");
		let seen: {
			path: string;
			token: string | null;
			body: Record<string, unknown>;
		} | null = null;
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const url = new URL(req.url);
				seen = {
					path: url.pathname,
					token: req.headers.get("x-klh-write-token"),
					body: (await req.json()) as Record<string, unknown>,
				};
				return Response.json({ ok: true, consult: "C11", state: "OPEN" });
			},
		});
		try {
			const wire = createBoardWire(
				cfg({
					writeTokenFile: tokenFile,
					boardUrl: `http://127.0.0.1:${server.port}`,
				}),
				"/repo",
			);
			const res = await wire.postConsult({
				project: "/repo",
				sid: "chatgpt-auto",
				q: "brief",
				best: true,
				scope: "W500",
			});
			expect(res.json.ok).toBe(true);
			expect(res.json.consult).toBe("C11");
			const s = seen as {
				path: string;
				token: string | null;
				body: Record<string, unknown>;
			} | null;
			expect(s?.path).toBe("/api/consult");
			expect(s?.token).toBe("tok-123");
			expect(s?.body.sid).toBe("chatgpt-auto");
			expect(s?.body.scope).toBe("W500");
		} finally {
			server.stop(true);
		}
	});
});
