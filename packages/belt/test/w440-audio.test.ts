// test/w440-audio.test.ts — W440: the audio tier (ElevenLabs TTS/STT).
// Registry rows + speak/transcribe helpers + the router's /v1/audio/*
// routes, proven at the wire level: a stub vendor server, the helpers
// pointed at it via ELEVENLABS_BASE, and real shim subprocesses with a
// sandboxed HOME. Missing key = clean 503 naming the env NAME; upstream
// errors carry the host, never a key value.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioBase, speak } from "../bin/audio.ts";
import {
	AUDIO_SERVICES,
	audioService,
	chatEntries,
	registryDoc,
} from "../bin/registry.ts";
import { emitDirectTiers, emitLitellmModelList } from "../bin/registry-emit.ts";

interface VendorCall {
	path: string;
	auth: string | null;
	model: string | null;
	text: string | null;
}

const vendorCalls: VendorCall[] = [];

const VENDOR = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		let model: string | null = null;
		let text: string | null = null;
		if (url.pathname.startsWith("/text-to-speech/")) {
			const j = (await req.json().catch(() => ({}))) as {
				text?: string;
				model_id?: string;
			};
			model = j.model_id ?? null;
			text = j.text ?? null;
		}
		vendorCalls.push({
			path: url.pathname,
			auth: req.headers.get("xi-api-key"),
			model,
			text,
		});
		if (url.pathname.startsWith("/text-to-speech/"))
			return new Response(new Uint8Array([1, 2, 3, 4]), {
				headers: { "content-type": "audio/mpeg" },
			});
		if (url.pathname === "/speech-to-text")
			return Response.json({ text: "stub heard this", language_code: "en" });
		return new Response("nope", { status: 404 });
	},
});

const SHIM = new URL("../bin/router-shim.ts", import.meta.url).pathname;
const findFreePort = (): number => {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(null),
	});
	const p = s.port ?? 0;
	s.stop(true);
	return p;
};

const PORT = findFreePort();
const PORT_NOKEY = findFreePort();
const HOME = mkdtempSync(join(tmpdir(), "w440-shim-home-"));
const proc = Bun.spawn(["bun", SHIM], {
	env: {
		...process.env,
		BELT_ROUTER_PORT: String(PORT),
		ELEVENLABS_API_KEY: "w440-test-key",
		ELEVENLABS_BASE: `http://127.0.0.1:${VENDOR.port}`,
		HOME,
	},
	stdout: "ignore",
	stderr: "pipe",
});
const noKeyProc = Bun.spawn(["bun", SHIM], {
	env: {
		...process.env,
		BELT_ROUTER_PORT: String(PORT_NOKEY),
		ELEVENLABS_API_KEY: "",
		HOME,
	},
	stdout: "ignore",
	stderr: "pipe",
});
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_NOKEY = `http://127.0.0.1:${PORT_NOKEY}`;

const waitHealthy = async (base: string): Promise<boolean> => {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${base}/health`);
			if (r.ok) return true;
		} catch {
			// not bound yet
		}
		await Bun.sleep(100);
	}
	return false;
};

afterAll(() => {
	proc.kill();
	noKeyProc.kill();
	VENDOR.stop(true);
});

describe("registry catalog rows (W440)", () => {
	test("tts + stt rows for elevenlabs, env-name keys only", () => {
		expect(AUDIO_SERVICES.map((s) => s.class)).toEqual(["tts", "stt"]);
		for (const s of AUDIO_SERVICES) {
			expect(s.provider).toBe("elevenlabs");
			expect(s.base).toBe("https://api.elevenlabs.io/v1");
			expect(s.keyEnv).toBe("ELEVENLABS_API_KEY");
			expect(JSON.stringify(s)).not.toMatch(/xi-api-key|Bearer /);
			expect(JSON.stringify(s)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
		}
		expect(audioService("tts")?.voice).toBeTruthy();
	});

	test("rows ride the registry doc, never the chat ladder emitters", () => {
		const doc = registryDoc();
		expect(doc.audio).toHaveLength(2);
		expect(chatEntries().some((e) => e.alias.includes("elevenlabs"))).toBe(
			false,
		);
		expect(emitDirectTiers()).not.toContain("elevenlabs");
		expect(emitLitellmModelList()).not.toContain("elevenlabs");
	});
});

describe("helpers (wire level, in-process)", () => {
	test("speak posts xi-api-key + model_id, returns vendor bytes", async () => {
		process.env.ELEVENLABS_API_KEY = "w440-test-key";
		process.env.ELEVENLABS_BASE = `http://127.0.0.1:${VENDOR.port}`;
		const r = await speak("lane W440 status", {
			voiceId: "VOICE-OVERRIDE",
		});
		expect(r.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(r.service.alias).toBe("elevenlabs-tts");
		expect(r.voiceId).toBe("VOICE-OVERRIDE");
		const call = vendorCalls.at(-1);
		expect(call?.path).toBe("/text-to-speech/VOICE-OVERRIDE");
		expect(call?.auth).toBe("w440-test-key");
		expect(call?.model).toBe("eleven_multilingual_v2");
		expect(call?.text).toBe("lane W440 status");
	});

	test("missing key names the env var, never a value", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		expect(audioBase()).toBe(`http://127.0.0.1:${VENDOR.port}`);
		try {
			await speak("x");
			throw new Error("expected throw");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).toContain("ELEVENLABS_API_KEY");
			expect(msg).not.toContain("w440-test-key");
		}
	});
});

describe("router speech route (shim subprocess)", () => {
	test("POST /v1/audio/speech → vendor bytes", async () => {
		expect(await waitHealthy(BASE)).toBe(true);
		const r = await fetch(`${BASE}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "lane W440 needs a decision" }),
		});
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("audio/mpeg");
		expect(r.headers.get("x-belt-audio")).toBe("elevenlabs-tts");
	});
});

describe("router speech route: bytes + vendor wire", () => {
	test("body bytes match the stub, vendor saw the key + default voice", async () => {
		const r = await fetch(`${BASE}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "status: all lanes green" }),
		});
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3, 4]),
		);
		const call = vendorCalls.at(-1);
		expect(call?.path).toBe("/text-to-speech/21m00Tcm4TlvDq8ikWAM");
		expect(call?.auth).toBe("w440-test-key");
	});
});

describe("router error paths", () => {
	test("empty input → 400", async () => {
		const r = await fetch(`${BASE}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(r.status).toBe(400);
	});
});

describe("router transcriptions route", () => {
	test("multipart upload → vendor text", async () => {
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array([9, 9, 9])]), "a.wav");
		form.append("model", "scribe_v1");
		const r = await fetch(`${BASE}/v1/audio/transcriptions`, {
			method: "POST",
			body: form,
		});
		expect(r.status).toBe(200);
		const j = (await r.json()) as { text?: string };
		expect(j.text).toBe("stub heard this");
		expect(r.headers.get("x-belt-audio")).toBe("elevenlabs-stt");
	});
});

describe("router missing-key path (no-key shim twin)", () => {
	test("speech + transcriptions → 503 naming the env var only", async () => {
		expect(await waitHealthy(BASE_NOKEY)).toBe(true);
		const s = await fetch(`${BASE_NOKEY}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi" }),
		});
		expect(s.status).toBe(503);
		const sj = (await s.json()) as { error?: { message?: string } };
		expect(sj.error?.message).toContain("ELEVENLABS_API_KEY");
		expect(sj.error?.message).not.toContain("w440-test-key");
		const t = await fetch(`${BASE_NOKEY}/v1/audio/transcriptions`, {
			method: "POST",
			body: new FormData(),
		});
		expect(t.status).toBe(503);
	});
});
