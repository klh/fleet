import { expect, test } from "@playwright/test";
import {
	validateWorkspaceArchive,
	type WorkspaceArchiveLimits,
} from "./workspace-archive.ts";

const encoder = new TextEncoder();

test("valid Unicode byte-order characters in path fields are preserved @unit", async () => {
	const parsed = await collect(
		archive(header("\uFEFFfile"), header("other", 0, "0", "\uFEFFdir")),
	);
	expect(
		parsed.events
			.filter((event) => event.kind === "header")
			.map((event) => event.header.path),
	).toEqual(["\uFEFFfile", "\uFEFFdir/other"]);
});
const limits = {
	maxEncodedBytes: 2_000_000,
	maxFileBytes: 1_000_000,
	maxEntries: 100,
};
function checksum(block: Uint8Array) {
	block.fill(32, 148, 156);
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return block;
}
function header(path: string, size = 0, type = "0", prefix = "") {
	const block = new Uint8Array(512);
	block.set(encoder.encode(path), 0);
	block.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
	block.set(encoder.encode(type), 156);
	block.set(encoder.encode("ustar\0"), 257);
	block.set(encoder.encode("00"), 263);
	block.set(encoder.encode(prefix), 345);
	return checksum(block);
}
function archive(...blocks: Uint8Array[]) {
	return Buffer.concat([...blocks, new Uint8Array(1024)]);
}
async function* chunks(bytes: Uint8Array, width = 137) {
	for (let offset = 0; offset < bytes.length; offset += width)
		yield bytes.subarray(offset, offset + width);
}
async function collect(
	bytes: Uint8Array,
	caps: WorkspaceArchiveLimits = limits,
	width = 137,
) {
	const events = [];
	for await (const event of validateWorkspaceArchive(
		chunks(bytes, width),
		caps,
	))
		events.push(event);
	return { events, raw: Buffer.concat(events.map((event) => event.bytes)) };
}

test("checksum corruption refuses before accepting an archive @unit", async () => {
	const block = header("file");
	block[0] ^= 1;
	await expect(collect(archive(block))).rejects.toThrow(/checksum/);
});

for (const path of [
	"/absolute",
	"../escape",
	"a/../b",
	"a//b",
	"a/./b",
	"././file",
	"",
	"file/",
])
	test(`unsafe regular path ${JSON.stringify(path)} refuses @unit`, async () => {
		await expect(collect(archive(header(path)))).rejects.toThrow(/path|name/);
	});
for (const type of ["1", "2", "3", "4", "6", "7", "x", "g", "L", "K", "S", "V"])
	test(`non-plain USTAR type ${type} refuses @unit`, async () => {
		await expect(collect(archive(header("file", 0, type)))).rejects.toThrow(
			/type/,
		);
	});
for (const size of [
	"00000000008\0",
	"0000001junk\0",
	"-0000000001\0",
	"0000 000001\0",
])
	test(`non-octal size ${JSON.stringify(size)} refuses @unit`, async () => {
		const block = header("file");
		block.set(encoder.encode(size), 124);
		await expect(collect(archive(checksum(block)))).rejects.toThrow(/octal/);
	});
for (const [field, offset] of Object.entries({
	magic: 257,
	version: 263,
	utf8: 0,
	base256: 124,
	namePadding: 10,
}))
	test(`malformed ${field} refuses with a valid checksum @unit`, async () => {
		const block = header("file");
		block[offset] = 255;
		await expect(collect(archive(checksum(block)))).rejects.toThrow(
			/magic|UTF-8|octal|name/,
		);
	});

test("directories cannot carry payload and root is only the first ./ directory @unit", async () => {
	await expect(collect(archive(header("dir/", 1, "5")))).rejects.toThrow(
		/payload/,
	);
	await expect(collect(archive(header("./")))).rejects.toThrow(/path/);
	await expect(
		collect(archive(header("file"), header("./", 0, "5"))),
	).rejects.toThrow(/root/);
	await expect(
		collect(archive(header("./", 0, "5"), header("./", 0, "5"))),
	).rejects.toThrow(/root/);
});

for (const [index, entries] of [
	[header("file"), header("./file")],
	[header("a/", 0, "5"), header("a/", 0, "5")],
	[header("a"), header("a/b")],
	[header("a/b"), header("a")],
	[header("a/", 0, "5"), header("a")],
].entries())
	test(`duplicate or conflicting path case ${index} refuses @unit`, async () => {
		await expect(collect(archive(...entries))).rejects.toThrow(
			/duplicate|conflict/,
		);
	});

test("implicit parents permit one later explicit directory and USTAR prefixes @unit", async () => {
	const bytes = archive(header("b", 0, "0", "a"), header("a/", 0, "5"));
	const parsed = await collect(bytes);
	expect(
		parsed.events.filter((e) => e.kind === "header").map((e) => e.header.path),
	).toEqual(["a/b", "a"]);
	expect(parsed.raw).toEqual(bytes);
});

test("encoded, cumulative payload and entry budgets refuse before requesting body @unit", async () => {
	await expect(
		collect(new Uint8Array(1024), { ...limits, maxEncodedBytes: 512 }, 1024),
	).rejects.toThrow(/encoded/);
	await expect(
		collect(archive(header("a"), header("b")), { ...limits, maxEntries: 1 }),
	).rejects.toThrow(/entry limit/);
	await expect(collect(archive(header("huge", 8_589_934_591)))).rejects.toThrow(
		/file byte limit/,
	);
	const body = new Uint8Array(512);
	await expect(
		collect(archive(header("a", 1), body, header("b", 1), body), {
			...limits,
			maxFileBytes: 1,
		}),
	).rejects.toThrow(/file byte limit/);
	let requestedBody = false,
		closed = false;
	async function* source() {
		try {
			yield header("file", 101);
			requestedBody = true;
			yield body;
		} finally {
			closed = true;
		}
	}
	await expect(
		(async () => {
			for await (const _event of validateWorkspaceArchive(source(), {
				...limits,
				maxFileBytes: 100,
			})) {
				/* exhaust */
			}
		})(),
	).rejects.toThrow(/file byte limit/);
	expect(requestedBody).toBe(false);
	expect(closed).toBe(true);
});

test("large upstream buffers are viewed in bounded chunks without changing bytes @unit", async () => {
	const input = archive(header("large", 131_073), new Uint8Array(131_584));
	const result = await collect(input, limits, input.length);
	expect(result.raw).toEqual(input);
	expect(result.events.every((event) => event.bytes.length <= 65536)).toBe(
		true,
	);
	const padded = Buffer.concat([input, new Uint8Array(1024)]);
	expect((await collect(padded)).raw).toEqual(padded);
});

test("nonzero file padding refuses @unit", async () => {
	const body = new Uint8Array(512);
	body[1] = 1;
	await expect(collect(archive(header("file", 1), body))).rejects.toThrow(
		/padding/,
	);
});

for (const mode of ["failure", "consumer stop", "source error"])
	test(`source iterator closes on ${mode} @unit`, async () => {
		let closed = false;
		async function* source() {
			try {
				if (mode === "failure") {
					const block = header("bad");
					block[0] ^= 1;
					yield block;
				} else {
					yield header("file", 1);
					if (mode === "source error") throw new Error("fixture source failed");
				}
				yield new Uint8Array(512);
			} finally {
				closed = true;
			}
		}
		const operation = async () => {
			for await (const event of validateWorkspaceArchive(source(), limits)) {
				if (mode === "consumer stop") {
					expect(event.kind).toBe("header");
					break;
				}
			}
		};
		if (mode === "consumer stop") await operation();
		else
			await expect(operation()).rejects.toThrow(
				mode === "failure" ? /checksum/ : /fixture source failed/,
			);
		expect(closed).toBe(true);
	});

for (const [label, bytes] of [
	["empty", new Uint8Array(0)],
	["partial header", new Uint8Array(511)],
	["one zero EOF", new Uint8Array(512)],
	["no EOF", header("file")],
	["body", Buffer.concat([header("file", 1000), new Uint8Array(10)])],
	[
		"partial trailing padding",
		Buffer.concat([archive(header("file")), new Uint8Array(1)]),
	],
	[
		"nonzero trailing block",
		Buffer.concat([archive(header("file")), new Uint8Array(512).fill(1)]),
	],
	["nonzero second EOF", Buffer.concat([new Uint8Array(512), header("file")])],
] as const)
	test(`truncated or malformed ${label} refuses @unit`, async () => {
		await expect(collect(bytes)).rejects.toThrow(/truncated|EOF|trailing/);
	});

test("real Docker GNU USTAR preserves raw binary bytes and normalizes workspace entries @unit", async () => {
	const { scratchWorld } = await import("@klh/test-kit");
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { runArgv, runArgvStream } = await import("./spawn.ts");
	const world = scratchWorld(),
		name = `archive-${crypto.randomUUID()}`;
	await mkdir(join(world.home, "nested"));
	await writeFile(
		join(world.home, "nested", "ユニコード\nfile"),
		new Uint8Array(131_073).fill(255),
	);
	await writeFile(join(world.home, "empty"), "");
	await writeFile(join(world.home, "back\\slash"), "data");
	const proc = await runArgvStream([
		"docker",
		"run",
		"--name",
		name,
		"--rm",
		"--read-only",
		"--network",
		"none",
		"--cap-drop",
		"ALL",
		"--user",
		`${process.getuid?.()}:${process.getgid?.()}`,
		"--mount",
		`type=bind,source=${world.home},target=/workspace,readonly`,
		"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895",
		"tar",
		"--format=ustar",
		"--blocking-factor=1",
		"-C",
		"/workspace",
		"-cf",
		"-",
		".",
	]);
	try {
		const original: Uint8Array[] = [],
			events = [];
		async function* source() {
			for await (const part of proc.stream) {
				original.push(part.slice());
				yield part;
			}
		}
		for await (const event of validateWorkspaceArchive(source(), limits))
			events.push(event);
		expect(await proc.exit).toBe(0);
		expect(
			events
				.filter((event) => event.kind === "header")
				.map((event) => event.header.path)
				.sort(),
		).toEqual([
			"",
			"back\\slash",
			"empty",
			"nested",
			"nested/ユニコード\nfile",
		]);
		expect(Buffer.concat(events.map((event) => event.bytes))).toEqual(
			Buffer.concat(original),
		);
		expect(events.every((event) => event.bytes.length <= 65536)).toBe(true);
		const validated = join(world.home, "validated.tar");
		await writeFile(
			validated,
			Buffer.concat(events.map((event) => event.bytes)),
		);
		const restored = await runArgv([
			"docker",
			"run",
			"--name",
			`${name}-restore`,
			"--rm",
			"--read-only",
			"--network",
			"none",
			"--cap-drop",
			"ALL",
			"--user",
			`${process.getuid?.()}:${process.getgid?.()}`,
			"--tmpfs",
			`/restored:rw,uid=${process.getuid?.()},gid=${process.getgid?.()}`,
			"--mount",
			`type=bind,source=${validated},target=/archive.tar,readonly`,
			"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895",
			"bun",
			"-e",
			'const p=Bun.spawnSync(["tar","--extract","--file","/archive.tar","--directory","/restored","--no-same-owner","--no-same-permissions"],{stderr:"inherit"});if(p.exitCode)process.exit(p.exitCode);const b=new Uint8Array(await Bun.file("/restored/nested/ユニコード\\nfile").arrayBuffer());console.log(JSON.stringify({binary:b.length===131073&&b.every(x=>x===255),empty:(await Bun.file("/restored/empty").arrayBuffer()).byteLength,literal:await Bun.file("/restored/back\\\\slash").text()}))',
		]);
		expect(restored.code, restored.stderr).toBe(0);
		expect(JSON.parse(restored.stdout)).toEqual({
			binary: true,
			empty: 0,
			literal: "data",
		});
	} finally {
		proc.kill();
		await proc.exit;
		try {
			const removals = await Promise.allSettled(
				[name, `${name}-restore`].map((ref) =>
					runArgv(["docker", "rm", "-f", ref]),
				),
			);
			for (const removal of removals) {
				expect(removal.status).toBe("fulfilled");
				if (removal.status === "fulfilled" && removal.value.code !== 0)
					expect(removal.value.stderr).toMatch(/no such (?:object|container)/i);
			}
		} finally {
			world.clean();
		}
	}
});
