// distill.test.ts — tests for bin/distill.ts (pure helpers; no
// network, no spawn). Run: bun test packages/belt/test/distill.test.ts
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
	DEFAULT_TEACHER_PORT,
	buildTrainArgs,
	generateRows,
	messagesFor,
	parseArgs,
	parsePackets,
	selectTeacher,
	slugify,
	splitRows,
	stripThink,
	toRow,
	type Chat,
	type Packet,
} from "../bin/distill.ts";

test.describe("packets", () => {
	const good = '{"id":"p1","question":"Q?","context":"C"}\n';

	test("parses valid jsonl rows @unit", () => {
		const { packets } = parsePackets(`${good}${good.replace("p1", "p2")}`);
		expect(packets).toHaveLength(2);
		expect(packets[0]?.id).toBe("p1");
	});

	test("skips blanks and reports malformed rows @unit", () => {
		const { packets, errors } = parsePackets(`not json\n\n${good}`);
		expect(packets).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("line 1");
	});

	test("rejects rows missing required fields @unit", () => {
		const { packets, errors } = parsePackets('{"id":"p1","question":"Q?"}\n');
		expect(packets).toHaveLength(0);
		expect(errors[0]).toContain("needs string id, question, context");
	});

	test("dedupes ids keeping first @unit", () => {
		const { packets, errors } = parsePackets(
			`${good}${good.replace("C", "C2")}`,
		);
		expect(packets).toHaveLength(1);
		expect(errors[0]).toContain("duplicate");
	});
});
test.describe("shapes", () => {
	const packet: Packet = {
		id: "p1",
		question: "What fleet port serves embeddings?",
		context: "The embed server answers on :8907.",
	};

	test("messagesFor puts context in system, question in user @unit", () => {
		const msgs = messagesFor(packet);
		expect(msgs).toHaveLength(2);
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[0]?.content).toContain(":8907");
		expect(msgs[1]?.content).toBe(packet.question);
	});

	test("toRow trains question → answer, context excluded @unit", () => {
		const row = toRow(packet, "Embeddings live on :8907.", "m", 8902);
		expect(row.id).toBe("p1");
		expect(row.teacher).toBe(8902);
		expect(row.messages).toEqual([
			{ role: "user", content: packet.question },
			{ role: "assistant", content: "Embeddings live on :8907." },
		]);
	});

	test("stripThink removes reasoning blocks @unit", () => {
		expect(stripThink("<think>hm</think>answer")).toBe("answer");
		expect(stripThink("<think>truncated")).toBe("");
	});

	test("generateRows uses the injected chat per packet @unit", async () => {
		const chat: Chat = async (msgs) => `A:${msgs[0]?.content.length}`;
		const rows = await generateRows(
			[packet, { ...packet, id: "p2" }],
			chat,
			"m",
			8902,
		);
		expect(rows).toHaveLength(2);
		expect(rows[1]?.id).toBe("p2");
		expect(rows[1]?.messages[1]?.content).toContain("A:");
	});
});
test.describe("split + slug", () => {
	test("splitRows holds one valid row for small sets @unit", () => {
		const rows = [1, 2, 3, 4, 5];
		const { train, valid } = splitRows(rows);
		expect(train).toHaveLength(4);
		expect(valid).toEqual([5]);
	});

	test("splitRows takes 10% for valid at scale @unit", () => {
		const rows = Array.from({ length: 20 }, (_, i) => i);
		const { train, valid } = splitRows(rows);
		expect(train).toHaveLength(18);
		expect(valid).toHaveLength(2);
	});

	test("splitRows empty stays empty @unit", () => {
		expect(splitRows([]).train).toHaveLength(0);
	});

	test("slugify is path-safe @unit", () => {
		expect(slugify("mlx-community/Qwen3-4B")).toBe("mlx-community-Qwen3-4B");
	});
});
test.describe("train args", () => {
	test("buildTrainArgs emits the distillation contract @unit", () => {
		const args = buildTrainArgs({
			model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
			dataDir: "/data",
			adapterPath: "/data/adapters",
			iters: 100,
			learningRate: "1e-5",
			numLayers: 16,
			batchSize: 1,
			saveEvery: 50,
		});
		expect(args).toContain("--mask-prompt");
		expect(args).toContain("--train");
		expect(args[args.indexOf("--fine-tune-type") + 1]).toBe("lora");
		expect(args[args.indexOf("--data") + 1]).toBe("/data");
		expect(args[args.indexOf("--iters") + 1]).toBe("100");
	});

	test("parseArgs defaults + overrides @unit", () => {
		const cli = parseArgs(["train", "--model", "m", "--iters", "7"]);
		expect(cli.verb).toBe("train");
		expect(cli.model).toBe("m");
		expect(cli.iters).toBe(7);
		expect(cli.learningRate).toBe("1e-5");
		const bare = parseArgs([]);
		expect(bare.verb).toBe("status");
		expect(bare.model).toBeUndefined();
	});
});
test.describe("teacher selection", () => {
	test("default teacher is the resident extract specialist @unit", () => {
		const t = selectTeacher(undefined);
		expect(t.port).toBe(DEFAULT_TEACHER_PORT);
		expect(t.tier).toBe("resident");
	});

	test("explicit port must be resident + chat-capable @unit", () => {
		expect(selectTeacher(8903).port).toBe(8903);
		expect(() => selectTeacher(9999)).toThrow(/candidates/);
		expect(() => selectTeacher(8913)).toThrow(/candidates/);
	});
});

test.describe("CLI subprocess", () => {
	test("status + plan run end-to-end in a sandboxed home @unit", () => {
		const env = {
			...process.env,
			DISTILL_HOME: "/tmp/w241-distill-test",
			PACKETS: "/tmp/w241-distill-test/none.jsonl",
		};
		for (const verb of ["status", "plan"]) {
			const p = Bun.spawnSync({
				cmd: ["bun", join(import.meta.dir, "..", "bin", "distill.ts"), verb],
				env,
				cwd: import.meta.dir,
			});
			expect(p.exitCode).toBe(0);
		}
	});
});
