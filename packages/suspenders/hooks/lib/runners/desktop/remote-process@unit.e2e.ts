import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { mkdir } from "node:fs/promises";
import { runArgv } from "./spawn.ts";
import { createRemoteProcessTransport } from "./remote-process.ts";
import { GUARDIAN } from "./remote-process/guardian.ts";
import { StartFrameSchema } from "./remote-process/protocol.ts";

test("control byte ceiling includes JSON escaping and guardian argv stays small @unit", () => {
	expect(Buffer.byteLength(GUARDIAN)).toBeLessThan(16384);
	expect(
		StartFrameSchema.safeParse({
			type: "start",
			argv: Array(8).fill("\u0001".repeat(8192)),
			stdin: "\u0000".repeat(65536),
		}).success,
	).toBe(false);
});

const IMAGE =
	"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const writer =
	"const f=require('node:fs');setInterval(()=>f.appendFileSync(process.argv[1],'x'),20)";

test("JSON-overhead refusal leaves the real container transport usable @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run(["true", ...Array(7).fill("\u0001".repeat(8192))], {
				stdin: "\u0001".repeat(65536),
			}),
		).rejects.toMatchObject({ name: "ZodError" });
		expect((await data.transport.run(["true"])).code).toBe(0);
		await data.transport.cleanup();
		await data.transport.assertQuiescent();
	} finally {
		await data.close();
	}
});

test("absent guest Bun refuses instead of installing a runtime helper @unit", async () => {
	const data = await fixture();
	let second = "";
	try {
		const empty = `${data.world.home}/empty`;
		await mkdir(empty);
		const result = await runArgv([
			"docker",
			"run",
			"--detach",
			"--rm",
			"--read-only",
			"--network",
			"none",
			"--cap-drop",
			"ALL",
			"--user",
			"1000:1000",
			"--mount",
			`type=bind,source=${empty},target=/usr/local/bin,readonly`,
			"--entrypoint",
			"/usr/bin/env",
			IMAGE,
			"sleep",
			"infinity",
		]);
		expect(result.code, result.stderr).toBe(0);
		second = result.stdout.trim();
		await expect(
			createRemoteProcessTransport({
				containerId: second,
				expectedPinnedImageRef: IMAGE,
				deadlineAt: Date.now() + 1000,
			}),
		).rejects.toThrow("remote-process.prerequisites");
	} finally {
		try {
			if (second) {
				const r = await runArgv(["docker", "rm", "-f", second]);
				expect(r.code, r.stderr).toBe(0);
			}
		} finally {
			await data.close();
		}
	}
});

test("private control refuses a second start injected from the guest @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run([
				"bun",
				"-e",
				"require('node:fs').writeFileSync('/proc/'+process.ppid+'/fd/0',JSON.stringify({type:'start',argv:['touch','/tmp/forbidden'],stdin:''})+'\\n');setInterval(()=>{},100)",
			]),
		).rejects.toThrow("remote-process.protocol");
		const check = await runArgv([
			"docker",
			"exec",
			data.id,
			"bun",
			"-e",
			"console.log(require('node:fs').existsSync('/tmp/forbidden'))",
		]);
		expect(check.code, check.stderr).toBe(0);
		expect(check.stdout.trim()).toBe("false");
		await expect(data.transport.cleanup()).rejects.toThrow(
			"remote-process.tainted",
		);
	} finally {
		await data.destroy();
	}
});

test("forged exit plus killed guardian cannot turn a remaining writer into quiescence @unit", async () => {
	const data = await fixture();
	try {
		const source = [
			"const fs=require('node:fs'),parent=process.ppid",
			`require('node:child_process').spawn('bun',['-e',${JSON.stringify(writer)},'/tmp/residue'],{stdio:'ignore'}).unref()`,
			"for(let i=0;i<100&&!fs.existsSync('/tmp/residue');i++)await Bun.sleep(10)",
			"if(!fs.existsSync('/tmp/residue'))throw Error('writer-not-ready')",
			"fs.writeFileSync('/proc/'+parent+'/fd/1',JSON.stringify({type:'exit',code:0})+String.fromCharCode(10))",
			"await Bun.sleep(100);process.kill(parent,'SIGKILL');process.exit(0)",
		].join(";");
		const result = await data.transport.run(["bun", "-e", source], {
			timeoutMs: 2000,
		});
		expect(result.code).toBe(0); // Guest-reported status is explicitly not a termination receipt.
		await expect.poll(() => data.size("/tmp/residue")).toBeGreaterThan(0);
		await data.transport.cleanup();
		await expect(data.transport.assertQuiescent()).rejects.toThrow(
			"remote-process.residue",
		);
	} finally {
		await data.close();
	}
});

test("an exit frame does not disable the bounded join deadline @unit", async () => {
	const data = await fixture(300);
	try {
		const start = Date.now();
		const result = data.transport.run(
			[
				"bun",
				"-e",
				"require('node:fs').writeFileSync('/proc/'+process.ppid+'/fd/1',JSON.stringify({type:'exit',code:0})+'\\n');process.kill(process.ppid,'SIGSTOP');setInterval(()=>{},100)",
			],
			{ timeoutMs: 300 },
		);
		await expect(
			Promise.race([
				result,
				Bun.sleep(2000).then(() => {
					throw Error("test.join-unbounded");
				}),
			]),
		).rejects.toThrow("remote-process.reap-failed");
		expect(Date.now() - start).toBeLessThan(1500);
		await expect(data.transport.cleanup()).rejects.toThrow(
			"remote-process.tainted",
		);
	} finally {
		await data.destroy();
	}
});

test("combined stdout and stderr share one output limit @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run(
				[
					"bun",
					"-e",
					"process.stdout.write('x'.repeat(12000));process.stderr.write('x'.repeat(12000));setInterval(()=>{},100)",
				],
				{ timeoutMs: 500, maxBytes: 16384 },
			),
		).rejects.toThrow("remote-process.output-limit");
	} finally {
		await data.close();
	}
});

test("unresponsive guardian cannot report successful cleanup @unit", async () => {
	const data = await fixture(300);
	try {
		await expect(
			data.transport.run(
				[
					"bun",
					"-e",
					"process.kill(process.ppid,'SIGSTOP');setInterval(()=>{},100)",
				],
				{ timeoutMs: 300 },
			),
		).rejects.toThrow("remote-process.reap-failed");
		await expect(data.transport.cleanup()).rejects.toThrow(
			"remote-process.tainted",
		);
		await expect(data.transport.assertQuiescent()).rejects.toThrow(
			"remote-process.not-quiescent",
		);
	} finally {
		await data.destroy();
	}
});

test("oversized malformed guest frames taint instead of buffering indefinitely @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run([
				"bun",
				"-e",
				"require('node:fs').writeFileSync('/proc/'+process.ppid+'/fd/1','x'.repeat(400000));setInterval(()=>{},100)",
			]),
		).rejects.toThrow("remote-process.protocol");
		await expect(data.transport.cleanup()).rejects.toThrow(
			"remote-process.tainted",
		);
	} finally {
		await data.destroy();
	}
});

test("output overflow cancels and joins without unbounded buffering @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run(
				[
					"bun",
					"-e",
					"setInterval(()=>process.stdout.write('x'.repeat(8192)),1)",
				],
				{ maxBytes: 16384 },
			),
		).rejects.toThrow("remote-process.output-limit");
		await data.transport.cleanup();
		await data.transport.assertQuiescent();
	} finally {
		await data.close();
	}
});

test("an escaped session prevents trustworthy quiescence @unit", async () => {
	const data = await fixture();
	try {
		await data.transport.run([
			"bun",
			"-e",
			"require('node:child_process').spawn('/usr/bin/setsid',['--wait','sleep','20'],{stdio:'ignore'}).unref()",
		]);
		await data.transport.cleanup();
		await expect(data.transport.assertQuiescent()).rejects.toThrow(
			"remote-process.residue",
		);
	} finally {
		await data.close();
	}
});

test("mismatched image and invalid argv refuse before command execution @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			createRemoteProcessTransport({
				containerId: data.id,
				expectedPinnedImageRef: `fixture/wrong@sha256:${"a".repeat(64)}`,
				deadlineAt: Date.now() + 1000,
			}),
		).rejects.toThrow("remote-process.identity");
		await expect(data.transport.run(["bad\u0000argv"])).rejects.toThrow();
		const abort = new AbortController();
		abort.abort();
		await expect(
			data.transport.run(["true"], { signal: abort.signal }),
		).rejects.toThrow("remote-process.aborted");
		await data.transport.cleanup();
		await data.transport.assertQuiescent();
	} finally {
		await data.close();
	}
});

test("aborting one command preserves a parallel command and cleanup joins it @unit", async () => {
	const data = await fixture();
	try {
		const abort = new AbortController();
		const a = data.transport.run(["bun", "-e", writer, "/tmp/a"], {
			signal: abort.signal,
		});
		const b = data.transport.run(["bun", "-e", writer, "/tmp/b"]);
		const aResult = expect(a).rejects.toThrow("remote-process.aborted");
		const bResult = expect(b).rejects.toThrow("remote-process.cleanup");
		await expect.poll(() => data.size("/tmp/a")).toBeGreaterThan(0);
		abort.abort();
		await aResult;
		const aSize = await data.size("/tmp/a"),
			bSize = await data.size("/tmp/b");
		await Bun.sleep(150);
		expect(await data.size("/tmp/a")).toBe(aSize);
		expect(await data.size("/tmp/b")).toBeGreaterThan(bSize);
		await data.transport.cleanup();
		await bResult;
		await data.transport.assertQuiescent();
		await expect(data.transport.run(["true"])).rejects.toThrow(
			"remote-process.closed",
		);
	} finally {
		await data.close();
	}
});

test("argv and stdin are exact; completed command reaps same-group descendants @unit", async () => {
	const data = await fixture();
	try {
		const marker = `${data.world.home}/host-must-not-exist`,
			arg = `$(touch ${marker}); 'quoted'`;
		const result = await data.transport.run(
			[
				"bun",
				"-e",
				"console.log(JSON.stringify({arg:process.argv[1],stdin:await new Response(Bun.stdin).text()}))",
				arg,
			],
			{ stdin: "zero\u0000\nλ" },
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ arg, stdin: "zero\u0000\nλ" });
		expect(await Bun.file(marker).exists()).toBe(false);
		await data.transport.run([
			"bun",
			"-e",
			"require('node:child_process').spawn('sleep',['20'],{stdio:'ignore'}).unref()",
		]);
		await data.transport.cleanup();
		await data.transport.assertQuiescent();
	} finally {
		await data.close();
	}
});

test("timeout joins the actual guest writer before returning @unit", async () => {
	const data = await fixture();
	try {
		await expect(
			data.transport.run(["bun", "-e", writer, "/tmp/timed"], {
				timeoutMs: 250,
			}),
		).rejects.toThrow("remote-process.timeout");
		const before = await data.size("/tmp/timed");
		expect(before).toBeGreaterThan(0);
		await Bun.sleep(150);
		expect(await data.size("/tmp/timed")).toBe(before);
		await data.transport.cleanup();
		await data.transport.assertQuiescent();
	} finally {
		await data.close();
	}
});

async function fixture(controlTimeoutMs = 2000) {
	const world = scratchWorld();
	const started = await runArgv([
		"docker",
		"run",
		"--detach",
		"--rm",
		"--read-only",
		"--network",
		"none",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		"1000:1000",
		"--tmpfs",
		"/tmp:rw,uid=1000,gid=1000",
		IMAGE,
		"sleep",
		"infinity",
	]);
	expect(started.code, started.stderr).toBe(0);
	const id = started.stdout.trim();
	try {
		const transport = await createRemoteProcessTransport({
			containerId: id,
			expectedPinnedImageRef: IMAGE,
			deadlineAt: Date.now() + 30_000,
			controlTimeoutMs,
		});
		return {
			id,
			world,
			transport,
			async destroy() {
				try {
					const r = await runArgv(["docker", "rm", "-f", id]);
					expect(r.code, r.stderr).toBe(0);
				} finally {
					world.clean();
				}
			},
			async size(path: string) {
				const r = await runArgv([
					"docker",
					"exec",
					id,
					"bun",
					"-e",
					"const f=require('node:fs');console.log(f.existsSync(process.argv[1])?f.statSync(process.argv[1]).size:0)",
					path,
				]);
				expect(r.code, r.stderr).toBe(0);
				return Number(r.stdout.trim());
			},
			async close() {
				try {
					await transport.cleanup();
				} finally {
					try {
						const r = await runArgv(["docker", "rm", "-f", id]);
						expect(r.code, r.stderr).toBe(0);
					} finally {
						world.clean();
					}
				}
			},
		};
	} catch (error) {
		await runArgv(["docker", "rm", "-f", id]);
		world.clean();
		throw error;
	}
}
