// scripts/posture-rollout-drill/drill-board.ts — W1315.6 drill C: the
// INSTALLED board serves the posture surface against the migrated drill
// conf — configured view, .prefer provenance, guarded CAS save
// (403/412/200), panel HTML, persistence across a full server restart.
// Run: bun scripts/posture-rollout-drill/drill-board.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assert,
	installed,
	rolloutDocument,
	scratchConf,
	INSTALLED,
} from "./rollout-drill.kit.ts";

type StoreModule = typeof import("../../hooks/lib/posture/posture.store.ts");
const storeMod = await installed<StoreModule>("hooks/lib/posture/posture.store.ts");

const { conf, world, reset, clean } = scratchConf("board");
mkdirSync(join(world, "home", ".claude", "local-llm"), { recursive: true });
mkdirSync(join(world, "repo"), { recursive: true });
// a fresh scratch world holds the pristine bytes — migrate it now
const zod = await installed<typeof import("../../hooks/lib/posture/posture.zod.ts")>(
	"hooks/lib/posture/posture.zod.ts",
);
storeMod.migrateStackPostureConfig(
	conf,
	zod.parsePostureDocument(JSON.stringify(rolloutDocument()), "drill/proposal"),
	storeMod.readStackPostureConfig(conf).revision,
);
process.env.KLH_STACK = conf;

const TOKEN = "drill-c-write-token-0123456789abcdef";
writeFileSync(join(world, "token"), TOKEN);

const freePort = async (): Promise<number> => {
	const { createServer } = await import("node:net");
	const server = createServer();
	server.listen(0, "127.0.0.1");
	const port: number = (server.address() as { port: number }).port;
	await new Promise<void>((r) => server.close(() => r()));
	return port;
};

type BoardProc = ReturnType<typeof Bun.spawn>;
const spawnBoard = async (port: number): Promise<{ proc: BoardProc; BASE: string }> => {
	const proc = Bun.spawn(
		[
			"bun",
			join(INSTALLED, "hooks", "bin", "fleet-board.ts"),
			"--port",
			String(port),
		],
		{
			cwd: join(INSTALLED, "hooks"),
			env: {
				...process.env,
				HOME: join(world, "home"),
				SUSPENDERS_WRITE_TOKEN_FILE: join(world, "token"),
				SUSPENDERS_MDNS: "0",
				SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
				SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
				SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const BASE = `http://127.0.0.1:${String(port)}`;
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${BASE}/api/tasks`);
			if (r.ok) return { proc, BASE };
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	proc.kill();
	throw new Error("installed board did not start");
};
const read = async (BASE: string): Promise<any> =>
	(await (await fetch(`${BASE}/api/posture`)).json());

let procBase = await spawnBoard(await freePort());
let proc = procBase.proc;
let BASE = procBase.BASE;
const stop = async (): Promise<void> => {
	proc.kill();
	await proc.exited;
};

// ── 1. configured view on the drill conf ──
const view = await read(BASE);
assert(view.ok && view.configured, "GET /api/posture → configured:true");
assert(
	view.selection.posture === "standard" &&
		view.postures.includes("minimal") &&
		view.postures.includes("dev"),
	`base selection standard; named postures ${JSON.stringify(view.postures)}`,
);
assert(
	view.effective.entries.length === 4 &&
		view.effective.entries.every((e: any) => e.hub === "local"),
	"effective entries resolved (4, hub local)",
);

// ── 2. .prefer provenance for ?project= ──
writeFileSync(
	join(world, "repo", ".prefer"),
	JSON.stringify({
		version: 1,
		selection: { fleet: "main", posture: "minimal" },
	}),
);
const proj = await fetch(
	`${BASE}/api/posture?project=${encodeURIComponent(join(world, "repo"))}`,
);
const pbody = await proj.json();
assert(
	pbody.effective.overridden === true &&
		pbody.effective.posture === "minimal" &&
		pbody.effective.overrides.some((s: string) => s.includes(".prefer")),
	"project override wins with .prefer source provenance",
);

// ── 3. guarded writes: 403 without token, 412 stale, 200 CAS ──
const post = (headers: Record<string, string>, body: unknown): Promise<Response> =>
	fetch(`${BASE}/api/posture/selection`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
const noToken = await post(
	{},
	{
		selection: { fleet: "main", posture: "dev", developmentOverride: false },
		revision: view.revision,
	},
);
assert(noToken.status === 403, "POST without write token → 403");
const stale = await post(
	{ "x-klh-write-token": TOKEN },
	{
		selection: { fleet: "main", posture: "dev", developmentOverride: false },
		revision: "0".repeat(64),
	},
);
assert(stale.status === 412, "POST with stale revision → 412");
const save = await post(
	{ "x-klh-write-token": TOKEN },
	{
		selection: { fleet: "main", posture: "minimal", developmentOverride: false },
		revision: (await read(BASE)).revision,
	},
);
assert(save.status === 200, "CAS save → 200");
assert(
	(await read(BASE)).selection.posture === "minimal",
	"saved base selection reads back (minimal)",
);

// ── 4. the dropdown panel ships in the served HTML ──
const html = await (await fetch(`${BASE}/`)).text();
assert(
	html.includes("klh-posture-panel"),
	"served board HTML mounts klh-posture-panel",
);

// ── 5. full server restart — selection persists ──
await stop();
procBase = await spawnBoard(await freePort());
proc = procBase.proc;
BASE = procBase.BASE;
const after = await read(BASE);
assert(
	after.ok && after.configured && after.selection.posture === "minimal",
	"selection survives a full board-server restart (machine conf, not browser storage)",
);
console.log("DRILL C COMPLETE — installed board posture surface + restart persistence");
await stop();
clean();
