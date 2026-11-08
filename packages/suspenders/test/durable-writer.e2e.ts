import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("Durable host writer excludes a second writer and releases without PID cleanup @unit", async () => {
	const { acquireHostWriter } = await import(
		"../hooks/lib/runners/durable/host-writer.ts"
	);
	const world = scratchWorld({ prefix: "durable-writer-" });
	try {
		const release = await acquireHostWriter(world.home);
		await expect(acquireHostWriter(world.home)).rejects.toThrow("writer");
		await release();
		const next = await acquireHostWriter(world.home);
		await next();
	} finally {
		world.clean();
	}
});

test("Durable writer kernel lock releases after SIGKILL with no stale PID recovery @unit", async () => {
	const { acquireHostWriter } = await import(
		"../hooks/lib/runners/durable/host-writer.ts"
	);
	const world = scratchWorld({ prefix: "durable-crash-" });
	const source = new URL(
		"../hooks/lib/runners/durable/host-writer.ts",
		import.meta.url,
	).href;
	const code = `import {acquireHostWriter} from ${JSON.stringify(source)};await acquireHostWriter(${JSON.stringify(world.home)});console.log('locked');await new Promise(()=>{});`;
	const child = Bun.spawn([process.execPath, "-e", code], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		const reader = child.stdout.getReader(),
			first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("locked");
		reader.releaseLock();
		await expect(acquireHostWriter(world.home)).rejects.toThrow("writer");
		child.kill("SIGKILL");
		await child.exited;
		const release = await acquireHostWriter(world.home);
		await release();
	} finally {
		clearTimeout(timeout);
		child.kill("SIGKILL");
		await child.exited;
		world.clean();
	}
});
