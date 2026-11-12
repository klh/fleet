import { expect, test } from "@playwright/test";
import {
	chmodSync,
	linkSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchSettingsHome } from "./helpers.ts";
import { readSettingsFile } from "../src/settings.reader.ts";

test("ordinary absent, public and malformed documents retain safe reader behavior", () => {
	const world = scratchSettingsHome();
	try {
		expect(readSettingsFile(world.file)).toBeNull();
		world.setFile({ version: "public-fixture", providers: {} });
		chmodSync(world.file, 0o644);
		expect(readSettingsFile(world.file)).toEqual({
			version: "public-fixture",
			providers: {},
		});
		world.writeRaw('{"fixture-private-sentinel" broken}');
		expect(() => readSettingsFile(world.file)).toThrow("Invalid JSON document");
		try {
			readSettingsFile(world.file);
		} catch (error) {
			expect(String(error)).not.toContain("fixture-private-sentinel");
		}
	} finally {
		world.clean();
	}
});

test("private provider files require one owned0600 inode", () => {
	const world = scratchSettingsHome();
	try {
		world.setFile({ providers: { fixture: { kind: "buckle" } } });
		chmodSync(world.file, 0o644);
		expect(() => readSettingsFile(world.file)).toThrow("0600");
		chmodSync(world.file, 0o600);
		expect(readSettingsFile(world.file)?.providers).toBeDefined();
		linkSync(world.file, join(world.home, "hardlinked.json"));
		expect(() => readSettingsFile(world.file)).toThrow("0600");
	} finally {
		world.clean();
	}
});

test("canonical reader refuses linked paths, including a dangling link", () => {
	const world = scratchSettingsHome();
	try {
		world.setFile({ version: "public-fixture" });
		chmodSync(world.file, 0o644);
		const linked = join(world.home, "linked.json");
		symlinkSync(world.file, linked);
		expect(() => readSettingsFile(linked)).toThrow();
		const dangling = join(world.home, "dangling.json");
		symlinkSync(join(world.home, "absent.json"), dangling);
		expect(() => readSettingsFile(dangling)).toThrow();
	} finally {
		world.clean();
	}
});

test("canonical reader refuses a FIFO promptly before reading JSON", () => {
	const world = scratchSettingsHome();
	try {
		const fifo = join(world.home, "settings.fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		chmodSync(fifo, 0o600);
		const module = new URL("../src/settings.reader.ts", import.meta.url).href;
		const code = `const {readSettingsFile}=await import(${JSON.stringify(module)});try{readSettingsFile(${JSON.stringify(fifo)});process.exit(2)}catch{console.log("refused")}`;
		const started = Date.now();
		const child = Bun.spawnSync([process.execPath, "-e", code], {
			env: { ...process.env, HOME: world.home, KLH_SETTINGS: fifo },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 500,
			killSignal: "SIGKILL",
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(child.stdout.toString().trim()).toBe("refused");
		expect(Date.now() - started).toBeLessThan(450);
	} finally {
		world.clean();
	}
});

test("bounded reader retains public nonsecret templates and private connection posture", () => {
	const world = scratchSettingsHome();
	try {
		writeFileSync(world.file, JSON.stringify({ version: "fixture" }));
		chmodSync(world.file, 0o644);
		expect(readSettingsFile(world.file)?.version).toBe("fixture");
		writeFileSync(world.file, `${" ".repeat(1048576)}{}`);
		expect(() => readSettingsFile(world.file)).toThrow();
		writeFileSync(
			world.file,
			JSON.stringify({
				providers: {
					peer: {
						kind: "buckle",
						adapter: "buckle",
						endpoints: { openai: "https://peer.example" },
					},
				},
			}),
		);
		expect(() => readSettingsFile(world.file)).toThrow();
		chmodSync(world.file, 0o600);
		expect(readSettingsFile(world.file)?.providers).toBeDefined();
	} finally {
		world.clean();
	}
});

test("pathname replacement during parsing cannot change captured bytes or private posture", () => {
	const world = scratchSettingsHome(),
		parse = JSON.parse;
	try {
		const original = JSON.stringify({
			providers: {
				fixture: {
					kind: "buckle",
					adapter: "buckle",
					endpoints: { openai: "https://fixture.example" },
				},
			},
		});
		world.writeRaw(original);
		chmodSync(world.file, 0o600);
		const replacement = join(world.home, "replacement.json");
		writeFileSync(replacement, JSON.stringify({ version: "replacement" }), {
			mode: 0o644,
		});
		let replaced = false;
		JSON.parse = (text) => {
			const value = parse(text);
			if (text === original) {
				renameSync(replacement, world.file);
				replaced = true;
			}
			return value;
		};
		expect(readSettingsFile(world.file)).toEqual(parse(original));
		expect(replaced).toBe(true);
	} finally {
		JSON.parse = parse;
		world.clean();
	}
});
