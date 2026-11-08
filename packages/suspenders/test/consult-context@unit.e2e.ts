// test/consult-context@unit.e2e.ts — W2863 faces (b)(d)(e): the managed
// consult-knowledge block upserts idempotently across the three CLI context
// files, never touching user content outside the markers; the pi receiver
// install face syncs the repo source into ~/.pi/agent/extensions/. Rides
// the kit (W1135.1.3).
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CONSULT_BLOCK_END,
	CONSULT_BLOCK_START,
	CONSULT_CONTEXT_BLOCK,
	installConsultContext,
} from "../scripts/install/install-consult-context.ts";
import { installPiReceiver } from "../scripts/install/install-pi-receiver.ts";

const world = scratchWorld({ prefix: "consult-ctx-" });
const home = (name: string): string => {
	const h = join(world.home, name);
	mkdirSync(h, { recursive: true });
	return h;
};

test.describe("@unit", () => {
	test("fresh home: all three CLI context files get the consult block", () => {
		const r = installConsultContext({ home: home("fresh") });
		expect(r.status).toBe("ok");
		expect(r.wrote).toHaveLength(3);
		expect(r.failed).toHaveLength(0);
		for (const p of r.wrote) {
			expect(existsSync(p)).toBe(true);
			const raw = readFileSync(p, "utf8");
			expect(raw).toContain(CONSULT_BLOCK_START);
			expect(raw).toContain("coord consult-reply");
			expect(raw).toContain("coord targets");
		}
	});
	test("existing user content is preserved; re-run is idempotent (kept)", () => {
		const h = home("preserve");
		const pi = join(h, ".pi/agent/AGENTS.md");
		mkdirSync(join(h, ".pi/agent"), { recursive: true });
		writeFileSync(pi, "# my notes\n\nkeep me\n");
		const r1 = installConsultContext({ home: h });
		expect(r1.wrote).toHaveLength(3);
		const raw = readFileSync(pi, "utf8");
		expect(raw).toContain("keep me");
		expect(raw).toContain(CONSULT_BLOCK_START);
		const r2 = installConsultContext({ home: h });
		expect(r2.kept).toHaveLength(3);
		const raw2 = readFileSync(pi, "utf8");
		expect(raw2).toContain("keep me");
		expect(raw2.split(CONSULT_BLOCK_START)).toHaveLength(2);
	});
	test("a stale managed block is replaced in place; surrounding prose survives", () => {
		const h = home("splice");
		const codex = join(h, ".codex/AGENTS.md");
		mkdirSync(join(h, ".codex"), { recursive: true });
		writeFileSync(
			codex,
			`head prose\n${CONSULT_BLOCK_START}\nstale body line\n${CONSULT_BLOCK_END}\ntail prose\n`,
		);
		const r = installConsultContext({ home: h });
		expect(r.wrote).toHaveLength(2);
		expect(r.kept).toHaveLength(1);
		const raw = readFileSync(codex, "utf8");
		expect(raw).toContain("head prose");
		expect(raw).toContain("tail prose");
		expect(raw).not.toContain("stale body line");
		expect(raw).toContain(CONSULT_CONTEXT_BLOCK);
	});
	test("dry-run plans without writing; a symlinked target refuses into failed", () => {
		const dryHome = join(world.home, "dry");
		const r = installConsultContext({ home: dryHome, dryRun: true });
		expect(r.status).toBe("planned");
		expect(r.wrote).toHaveLength(0);
		expect(existsSync(join(dryHome, ".pi/agent/AGENTS.md"))).toBe(false);
		const h = home("symlink");
		const real = join(h, "real.md");
		writeFileSync(real, "target\n");
		mkdirSync(join(h, ".pi/agent"), { recursive: true });
		symlinkSync(real, join(h, ".pi/agent/AGENTS.md"));
		const rs = installConsultContext({ home: h });
		expect(rs.wrote).toHaveLength(2);
		expect(rs.failed).toHaveLength(1);
		expect(rs.failed[0]).toContain("pi:");
		expect(readFileSync(real, "utf8")).toBe("target\n");
	});
	test("pi receiver install: planned → synced → current (byte-identical)", () => {
		const h = home("receiver");
		const dry = installPiReceiver({ home: h, dryRun: true });
		expect(dry.status).toBe("planned");
		const dst = join(h, ".pi/agent/extensions/fleet-receiver/index.ts");
		expect(existsSync(dst)).toBe(false);
		const s1 = installPiReceiver({ home: h });
		expect(s1.action).toBe("synced");
		expect(readFileSync(dst, "utf8")).toBe(
			readFileSync(
				join(
					import.meta.dir,
					"..",
					"pi-extensions",
					"fleet-receiver",
					"index.ts",
				),
				"utf8",
			),
		);
		expect(installPiReceiver({ home: h }).action).toBe("current");
	});

	test.afterAll(() => {
		world.clean();
	});
});
