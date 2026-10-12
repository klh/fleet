// distill.ts — W241 context distillation: packets → resident teacher's
// with-context answers → LoRA (mlx_lm.lora) on the base model. Training pairs
// are (question → answered-with-context): the packet is the teacher's input,
// never the student's, so the LoRA bakes the knowledge in. Packets stay on
// disk — cold (non-resident) models keep consuming them as runtime context.
//
// Verbs: plan | generate | train | run | status
//   bun distill.ts plan
//   bun distill.ts generate --port 8902
//   bun distill.ts train --model <hf-id> [--iters 100]
//   bun distill.ts run
//   bun distill.ts status
//
// DISTILL_HOME/<model-slug>/ holds distilled.jsonl, train.jsonl, valid.jsonl,
// adapters/ (mlx_lm.lora --adapter-path) and train.log. Packets: JSONL rows
// {"id","question","context"} at ~/.claude/local-llm/packets/packets.jsonl
// (--packets overrides).
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPECIALISTS, type Specialist } from "./registry.ts";
// ── types ──
export interface Packet {
	id: string;
	question: string;
	context: string;
}

export interface ChatMsg {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface DistillRow {
	id: string;
	model: string;
	teacher: number;
	ts: string;
	messages: ChatMsg[];
}

export interface TrainOptions {
	model: string;
	dataDir: string;
	adapterPath: string;
	iters: number;
	learningRate: string;
	numLayers: number;
	batchSize: number;
	saveEvery: number;
}
export interface Cli {
	verb: string;
	port?: number;
	model?: string;
	packets?: string;
	iters: number;
	learningRate: string;
	maxTokens: number;
	home: string;
}

// ── constants (config-over-code: paths overridable via env/flags) ──
export const CHAT_ROLES = ["code", "extract", "reason", "general"] as const;
export const DEFAULT_TEACHER_PORT = 8902;
export const DEFAULT_ITERS = 100;
export const DEFAULT_LR = "1e-5";
export const DEFAULT_MAX_TOKENS = 1024;
export const TEACHER_SYSTEM =
	"Answer using ONLY the context below. Carry over every fact the context " +
	"gives; add nothing from outside it. Be complete but compact. /no_think";
// ── paths ──
export function distillHome(): string {
	return (
		process.env.DISTILL_HOME ??
		join(homedir(), ".claude", "local-llm", "distill")
	);
}

export function packetsPath(cliPackets?: string): string {
	return (
		cliPackets ??
		process.env.PACKETS ??
		join(homedir(), ".claude", "local-llm", "packets", "packets.jsonl")
	);
}

export function mlxLmLoraBin(): string {
	if (process.env.MLX_LM_LORA) return process.env.MLX_LM_LORA;
	const uv = join(homedir(), ".local/share/uv/tools/mlx-lm/bin/mlx_lm.lora");
	return existsSync(uv) ? uv : "mlx_lm.lora";
}
// ── packets ──
export function parsePackets(text: string): {
	packets: Packet[];
	errors: string[];
} {
	const packets: Packet[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	text.split("\n").forEach((line, idx) => {
		const t = line.trim();
		if (!t) return;
		let row: unknown;
		try {
			row = JSON.parse(t);
		} catch {
			errors.push(`line ${idx + 1}: not JSON`);
			return;
		}
		const r = row as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		const question = typeof r.question === "string" ? r.question : "";
		const context = typeof r.context === "string" ? r.context : "";
		if (!id || !question || !context) {
			errors.push(`line ${idx + 1}: needs string id, question, context`);
			return;
		}
		if (seen.has(id)) {
			errors.push(`line ${idx + 1}: duplicate id ${id} (kept first)`);
			return;
		}
		seen.add(id);
		packets.push({ id, question, context });
	});
	return { packets, errors };
}
export async function loadPackets(path: string): Promise<Packet[]> {
	if (!existsSync(path)) return [];
	const text = await readFile(path, "utf8");
	const { packets, errors } = parsePackets(text);
	for (const e of errors) console.error(`packets: ${e}`);
	return packets;
}

// ── teacher selection (resident + chat-capable only) ──
export function teacherCandidates(): Specialist[] {
	return SPECIALISTS.filter(
		(s) =>
			s.tier === "resident" &&
			(CHAT_ROLES as readonly string[]).includes(s.role),
	);
}
export function selectTeacher(port?: number): Specialist {
	const candidates = teacherCandidates();
	if (port === undefined) {
		return (
			candidates.find((s) => s.port === DEFAULT_TEACHER_PORT) ?? candidates[0]
		);
	}
	const hit = candidates.find((s) => s.port === port);
	if (!hit) {
		throw new Error(
			`no resident chat specialist on :${port} — candidates: ${candidates.map((s) => s.port).join(", ")}`,
		);
	}
	return hit;
}

export function messagesFor(packet: Packet): ChatMsg[] {
	return [
		{ role: "system", content: `${TEACHER_SYSTEM}\n\n${packet.context}` },
		{ role: "user", content: packet.question },
	];
}
export function toRow(
	packet: Packet,
	answer: string,
	model: string,
	teacherPort: number,
): DistillRow {
	return {
		id: packet.id,
		model,
		teacher: teacherPort,
		ts: new Date().toISOString(),
		// The training pair: bare question → with-context answer. The context
		// is NOT in the row — masking the prompt trains the answer, not the input.
		messages: [
			{ role: "user", content: packet.question },
			{ role: "assistant", content: answer },
		],
	};
}

export function stripThink(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/<think>[\s\S]*$/g, "")
		.trim();
}
// ── split + args ──
export function splitRows<T>(rows: T[]): { train: T[]; valid: T[] } {
	if (rows.length === 0) return { train: [], valid: [] };
	const validCount = rows.length >= 10 ? Math.floor(rows.length / 10) : 1;
	return {
		train: rows.slice(0, rows.length - validCount),
		valid: rows.slice(rows.length - validCount),
	};
}

export function slugify(model: string): string {
	return model.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
export function buildTrainArgs(o: TrainOptions): string[] {
	return [
		"--train",
		"--model",
		o.model,
		"--data",
		o.dataDir,
		"--fine-tune-type",
		"lora",
		"--mask-prompt",
		"--num-layers",
		String(o.numLayers),
		"--batch-size",
		String(o.batchSize),
		"--iters",
		String(o.iters),
		"--learning-rate",
		o.learningRate,
		"--save-every",
		String(o.saveEvery),
		"--adapter-path",
		o.adapterPath,
	];
}
// ── CLI parsing ──
export function parseArgs(argv: string[]): Cli {
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			flags.set(a.slice(2), true);
		} else {
			flags.set(a.slice(2), next);
			i++;
		}
	}
	const num = (k: string, d: number): number => {
		const v = flags.get(k);
		if (typeof v !== "string") return d;
		const n = Number(v);
		return Number.isFinite(n) ? n : d;
	};
	const str = (k: string): string | undefined => {
		const v = flags.get(k);
		return typeof v === "string" ? v : undefined;
	};
	return {
		verb: argv[0] ?? "status",
		port: num("port", 0) || undefined,
		model: str("model"),
		packets: str("packets"),
		iters: num("iters", DEFAULT_ITERS),
		learningRate: str("learning-rate") ?? DEFAULT_LR,
		maxTokens: num("max-tokens", DEFAULT_MAX_TOKENS),
		home: str("home") ?? distillHome(),
	};
}
// ── generation ──
export type Chat = (messages: ChatMsg[]) => Promise<string>;

export function specialistChat(spec: Specialist, maxTokens: number): Chat {
	return async (messages) => {
		const r = await fetch(`http://localhost:${spec.port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: spec.model,
				messages,
				max_tokens: maxTokens,
				temperature: 0.2,
				stream: false,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (!r.ok) throw new Error(`:${spec.port} HTTP ${r.status}`);
		const j = await r.json();
		const answer = stripThink(j.choices?.[0]?.message?.content ?? "");
		if (!answer) throw new Error(`:${spec.port} empty answer`);
		return answer;
	};
}

export async function generateRows(
	packets: Packet[],
	chat: Chat,
	model: string,
	teacherPort: number,
): Promise<DistillRow[]> {
	const rows: DistillRow[] = [];
	for (const p of packets) {
		const answer = await chat(messagesFor(p));
		rows.push(toRow(p, answer, model, teacherPort));
	}
	return rows;
}
// ── commands ──
function modelFor(cli: Cli): { teacher: Specialist; model: string } {
	const teacher = selectTeacher(cli.port);
	return { teacher, model: cli.model ?? teacher.model };
}

async function cmdPlan(cli: Cli): Promise<void> {
	const { teacher, model } = modelFor(cli);
	const packets = await loadPackets(packetsPath(cli.packets));
	const dir = join(cli.home, slugify(model));
	console.log("plan:");
	console.log(`  packets:    ${packets.length} @ ${packetsPath(cli.packets)}`);
	console.log(`  teacher:    :${teacher.port} ${teacher.model} (resident)`);
	console.log(`  student:    ${model}`);
	console.log(`  out:        ${dir}`);
	console.log(`  iters/lr:   ${cli.iters} / ${cli.learningRate}`);
	console.log("  cold:       ondemand + external models keep packets");
}
async function cmdGenerate(cli: Cli): Promise<void> {
	const { teacher, model } = modelFor(cli);
	const packets = await loadPackets(packetsPath(cli.packets));
	if (packets.length === 0) {
		throw new Error(
			`no packets at ${packetsPath(cli.packets)} — add {"id","question","context"} rows first`,
		);
	}
	const dir = join(cli.home, slugify(model));
	await mkdir(dir, { recursive: true });
	const chat = specialistChat(teacher, cli.maxTokens);
	const rows = await generateRows(packets, chat, model, teacher.port);
	const outPath = join(dir, "distilled.jsonl");
	await writeFile(
		outPath,
		`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	console.log(`distilled ${rows.length} packets → ${outPath}`);
}
// ── training ──
async function prepareData(
	dir: string,
): Promise<{ train: number; valid: number }> {
	const distilled = join(dir, "distilled.jsonl");
	if (!existsSync(distilled)) {
		throw new Error(`no ${distilled} — run generate first`);
	}
	const text = await readFile(distilled, "utf8");
	const rows = text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as DistillRow);
	if (rows.length < 2) {
		throw new Error(`need ≥2 distilled rows, have ${rows.length}`);
	}
	const { train, valid } = splitRows(rows);
	const asJsonl = (rs: DistillRow[]): string =>
		`${rs.map((r) => JSON.stringify({ messages: r.messages })).join("\n")}\n`;
	await writeFile(join(dir, "train.jsonl"), asJsonl(train));
	await writeFile(join(dir, "valid.jsonl"), asJsonl(valid));
	return { train: train.length, valid: valid.length };
}
async function runTrainer(args: string[], logPath: string): Promise<void> {
	const bin = mlxLmLoraBin();
	await appendFile(
		logPath,
		`\n# ${new Date().toISOString()} ${bin} ${args.join(" ")}\n`,
	);
	const p = Bun.spawn([bin, ...args], {
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	// Stream chunks into train.log while the trainer runs.
	const sink = Bun.file(logPath).writer();
	const pump = async (s: ReadableStream<Uint8Array>): Promise<void> => {
		const reader = s.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			sink.write(value);
		}
	};
	await Promise.all([pump(p.stdout), pump(p.stderr), p.exited]);
	await sink.end();
	if (p.exitCode !== 0) {
		throw new Error(`mlx_lm.lora exited ${p.exitCode} — see ${logPath}`);
	}
}
async function cmdTrain(cli: Cli): Promise<void> {
	const { model } = modelFor(cli);
	const dir = join(cli.home, slugify(model));
	const counts = await prepareData(dir);
	const adapterPath = join(dir, "adapters");
	await mkdir(adapterPath, { recursive: true });
	const args = buildTrainArgs({
		model,
		dataDir: dir,
		adapterPath,
		iters: cli.iters,
		learningRate: cli.learningRate,
		numLayers: 16,
		batchSize: 1,
		saveEvery: Math.max(10, Math.floor(cli.iters / 2)),
	});
	console.log(
		`training ${model}: ${counts.train} train / ${counts.valid} valid`,
	);
	console.log(`  $ ${mlxLmLoraBin()} ${args.join(" ")}`);
	await runTrainer(args, join(dir, "train.log"));
	for (const f of ["adapter_config.json", "adapters.safetensors"]) {
		if (!existsSync(join(adapterPath, f))) {
			throw new Error(`trainer done but ${f} missing in ${adapterPath}`);
		}
	}
	console.log(`adapters: ${adapterPath}`);
}
async function cmdStatus(cli: Cli): Promise<void> {
	const pp = packetsPath(cli.packets);
	const packets = await loadPackets(pp);
	console.log(`packets: ${packets.length} @ ${pp}`);
	if (packets.length === 0) {
		console.log('  add rows: {"id","question","context"} — packets are kept');
	}
	console.log(`hot (LoRA-baked, DISTILL_HOME=${cli.home}):`);
	for (const t of teacherCandidates()) {
		const dir = join(cli.home, slugify(t.model));
		const adapter = join(dir, "adapters", "adapters.safetensors");
		const d = join(dir, "distilled.jsonl");
		const n = existsSync(d)
			? (await readFile(d, "utf8")).split("\n").filter((l) => l.trim()).length
			: 0;
		const state = existsSync(adapter)
			? "adapter ✓"
			: n > 0
				? "distilled, untrained"
				: "no packets distilled";
		console.log(`  :${t.port} ${t.model} — ${state} (${n} rows)`);
	}
	console.log("cold (packets kept for runtime context):");
	for (const s of SPECIALISTS.filter((s) => s.tier === "ondemand")) {
		console.log(`  :${s.port} ${s.model} (ondemand)`);
	}
	console.log("  router :4000 + cloud — packets passed as context per request");
}
// ── dispatch ──
async function main(): Promise<void> {
	const cli = parseArgs(process.argv.slice(2));
	try {
		switch (cli.verb) {
			case "plan":
				await cmdPlan(cli);
				break;
			case "generate":
				await cmdGenerate(cli);
				break;
			case "train":
				await cmdTrain(cli);
				break;
			case "run":
				await cmdGenerate(cli);
				await cmdTrain(cli);
				await cmdStatus(cli);
				break;
			case "status":
				await cmdStatus(cli);
				break;
			default:
				console.log(
					"Usage: bun distill.ts {plan|generate|train|run|status} [--port N] [--model hf-id] [--packets file] [--iters N] [--learning-rate f] [--max-tokens N]",
				);
		}
	} catch (e) {
		console.error(`distill: ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
