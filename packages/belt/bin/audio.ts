// bin/audio.ts — belt's audio tier (W440): TTS/STT behind the router.
// Catalog rows live in bin/registry.ts (AUDIO_SERVICES); the vendor key is
// machine config ONLY (ELEVENLABS_API_KEY via ~/.claude/local-llm/belt.env,
// 0600) — never committed, never logged, never printed. ELEVENLABS_BASE
// overrides the vendor base (tests/staging). CLI:
//   bun bin/audio.ts speak <text...> --out FILE [--voice ID] [--model ID]
//   bun bin/audio.ts transcribe FILE [--model ID] [--language CODE]
//   bun bin/audio.ts status
import { AUDIO_SERVICES, type AudioService, audioService } from "./registry.ts";

const VENDOR_BASE = "https://api.elevenlabs.io/v1";
const TIMEOUT_MS = 120_000;

/** Vendor base: ELEVENLABS_BASE overrides (tests/staging); default is the
 *  vendor's public API. */
export const audioBase = (): string =>
	process.env.ELEVENLABS_BASE || VENDOR_BASE;

/** Vendor auth: the key rides the xi-api-key header. Read at call time from
 *  the env NAME on the catalog row — undefined = not set. Never logged. */
export function audioKey(svc: AudioService): string | undefined {
	const v = process.env[svc.keyEnv];
	return v ? v : undefined;
}

export interface SpeakOptions {
	voiceId?: string;
	modelId?: string;
}

export interface SpeakResult {
	audio: Uint8Array;
	service: AudioService;
	voiceId: string;
}

/** Text → speech bytes (mp3). Throws naming the env var when the key is
 *  unset; upstream errors name the host only, never a value. */
export async function speak(
	text: string,
	opts: SpeakOptions = {},
): Promise<SpeakResult> {
	const svc = audioService("tts");
	if (!svc) throw new Error("audio: no tts row in the catalog");
	const key = audioKey(svc);
	if (!key)
		throw new Error(
			`${svc.keyEnv} is not set — add it to machine config (~/.claude/local-llm/belt.env), never the repo`,
		);
	const voiceId = opts.voiceId ?? svc.voice;
	if (!voiceId) throw new Error("audio: no voice id on the tts row");
	const r = await fetch(
		`${audioBase()}/text-to-speech/${encodeURIComponent(voiceId)}`,
		{
			method: "POST",
			headers: { "xi-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({
				text,
				model_id: opts.modelId ?? svc.model,
				output_format: "mp3_44100_128",
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		},
	);
	if (!r.ok) {
		await r.body?.cancel();
		throw new Error(
			`audio: HTTP ${r.status} from ${new URL(audioBase()).host}`,
		);
	}
	return {
		audio: new Uint8Array(await r.arrayBuffer()),
		service: svc,
		voiceId,
	};
}

export interface TranscribeOptions {
	modelId?: string;
	language?: string;
}

export interface TranscribeResult {
	text: string;
	languageCode: string | null;
	service: AudioService;
}

/** Audio blob → text (multipart upload). Same key/host discipline as
 *  speak(): env-name errors, host-only upstream errors. */
export async function transcribe(
	audio: Blob,
	opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
	const svc = audioService("stt");
	if (!svc) throw new Error("audio: no stt row in the catalog");
	const key = audioKey(svc);
	if (!key)
		throw new Error(
			`${svc.keyEnv} is not set — add it to machine config (~/.claude/local-llm/belt.env), never the repo`,
		);
	const form = new FormData();
	form.append("file", audio, "audio");
	form.append("model_id", opts.modelId ?? svc.model);
	if (opts.language) form.append("language_code", opts.language);
	const r = await fetch(`${audioBase()}/speech-to-text`, {
		method: "POST",
		headers: { "xi-api-key": key },
		body: form,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!r.ok) {
		await r.body?.cancel();
		throw new Error(
			`audio: HTTP ${r.status} from ${new URL(audioBase()).host}`,
		);
	}
	const j = (await r.json()) as { text?: unknown; language_code?: unknown };
	return {
		text: typeof j.text === "string" ? j.text : "",
		languageCode: typeof j.language_code === "string" ? j.language_code : null,
		service: svc,
	};
}

// ─── router handlers (W440): OpenAI audio wire → Response ───
// 400 bad input · 503 key missing (env NAME only) · 502 upstream failure.
export async function audioSpeech(req: Request): Promise<Response> {
	const t0 = Date.now();
	const b = (await req.json().catch(() => null)) as {
		input?: unknown;
		voice?: unknown;
		model?: unknown;
	} | null;
	const text = typeof b?.input === "string" ? b.input : "";
	const svc = audioService("tts");
	if (!text)
		return Response.json(
			{ error: { message: "input (string) is required" } },
			{ status: 400 },
		);
	if (!svc || !audioKey(svc))
		return Response.json(
			{
				error: {
					message: `${svc?.keyEnv ?? "audio key env"} not set — machine config only`,
				},
			},
			{ status: 503 },
		);
	try {
		const r = await speak(text, {
			voiceId: typeof b?.voice === "string" ? b.voice : undefined,
			modelId: typeof b?.model === "string" ? b.model : undefined,
		});
		return new Response(r.audio, {
			headers: {
				"content-type": "audio/mpeg",
				"x-belt-audio": r.service.alias,
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`audio-tts ${Date.now() - t0}ms failed: ${msg}`);
		return Response.json({ error: { message: msg } }, { status: 502 });
	}
}

/** POST /v1/audio/transcriptions (multipart: file[, model, language]) →
 *  {text}. Same key discipline as audioSpeech(). */
export async function audioTranscribe(req: Request): Promise<Response> {
	const t0 = Date.now();
	const svc = audioService("stt");
	if (!svc || !audioKey(svc))
		return Response.json(
			{
				error: {
					message: `${svc?.keyEnv ?? "audio key env"} not set — machine config only`,
				},
			},
			{ status: 503 },
		);
	const form = await req.formData().catch(() => null);
	const file = form?.get("file");
	const model = form?.get("model");
	const lang = form?.get("language");
	if (!(file instanceof Blob))
		return Response.json(
			{ error: { message: "file (multipart) is required" } },
			{ status: 400 },
		);
	try {
		const t = await transcribe(file, {
			modelId: typeof model === "string" ? model : undefined,
			language: typeof lang === "string" ? lang : undefined,
		});
		return Response.json(
			{ text: t.text },
			{
				headers: { "x-belt-audio": t.service.alias },
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`audio-stt ${Date.now() - t0}ms failed: ${msg}`);
		return Response.json({ error: { message: msg } }, { status: 502 });
	}
}

// ─── CLI ───
const USAGE = `usage: bun bin/audio.ts speak <text...> --out FILE [--voice ID] [--model ID]
       bun bin/audio.ts transcribe FILE [--model ID] [--language CODE]
       bun bin/audio.ts status`;

/** Split CLI flags out of an argv tail: --flag value pairs into opts, the
 *  remaining bare words stay positional. */
function splitFlags(
	rest: string[],
	flags: string[],
): { words: string[]; opts: Map<string, string> } {
	const opts = new Map<string, string>();
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a && flags.includes(a) && i + 1 < rest.length) {
			const v = rest[i + 1];
			if (v !== undefined) opts.set(a, v);
			i++;
		} else words.push(a);
	}
	return { words, opts };
}

async function main(argv: string[]): Promise<number> {
	const [cmd = "", ...rest] = argv;
	if (cmd === "status") {
		const base = audioBase();
		console.log(`audio base: ${base}`);
		for (const s of AUDIO_SERVICES)
			console.log(
				`  ${s.class.padEnd(4)} ${s.alias}  ${s.model}  key:${
					audioKey(s) ? "set" : "MISSING"
				}`,
			);
		return 0;
	}
	if (cmd === "speak") {
		const { words, opts } = splitFlags(rest, ["--out", "--voice", "--model"]);
		const text = words.join(" ").trim();
		const out = opts.get("--out");
		if (!text || !out) {
			console.error(USAGE);
			return 2;
		}
		const r = await speak(text, {
			voiceId: opts.get("--voice"),
			modelId: opts.get("--model"),
		});
		await Bun.write(out, r.audio);
		console.error(
			`${r.service.alias} ← ${text.length} chars → ${out} (${r.audio.length} bytes, voice ${r.voiceId})`,
		);
		return 0;
	}
	if (cmd === "transcribe") {
		const { words, opts } = splitFlags(rest, ["--model", "--language"]);
		const file = words[0];
		if (!file) {
			console.error(USAGE);
			return 2;
		}
		const blob = new Blob([await Bun.file(file).arrayBuffer()]);
		const r = await transcribe(blob, {
			modelId: opts.get("--model"),
			language: opts.get("--language"),
		});
		console.log(r.text);
		return 0;
	}
	console.error(USAGE);
	return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
