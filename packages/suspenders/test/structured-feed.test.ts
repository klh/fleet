import { expect, test } from "bun:test";
import { captureClaimFeed } from "../scripts/lib/structured-feed.ts";
const command = (code: string) => [process.execPath, "-e", code];
test("structured feed drains complete JSON over 64 KiB and separates stderr", async () => {
	const rows = await captureClaimFeed(
		command(
			`console.error("producer warning");process.stdout.write(JSON.stringify(Array.from({length:2000},(_,i)=>({id:"W"+i,title:"x".repeat(80)}))))`,
		),
		process.cwd(),
	);
	expect(rows).toHaveLength(2000);
	expect(rows[1999].id).toBe("W1999");
});
test("malformed, partial and non-array feeds never mean no candidates", async () => {
	for (const code of [
		`process.stdout.write(JSON.stringify([{id:"W1"}]).slice(0,-1))`,
		`console.log("{}")`,
		`console.log("[null]")`,
	])
		await expect(
			captureClaimFeed(command(code), process.cwd()),
		).rejects.toThrow("structured feed");
});
test("oversized feeds fail explicitly rather than parsing a clipped prefix", async () => {
	await expect(
		captureClaimFeed(
			command(
				`console.log(JSON.stringify([{id:"W1",title:"x".repeat(3000)}]));`,
			),
			process.cwd(),
			{ maxBytes: 1024 },
		),
	).rejects.toThrow("exceeds 1024 bytes");
});
test("failed producer and hung producer are visible", async () => {
	await expect(
		captureClaimFeed(
			command(`console.error("store unavailable");process.exit(3);`),
			process.cwd(),
		),
	).rejects.toThrow("exit 3");
	await expect(
		captureClaimFeed(command(`setInterval(()=>{},1000);`), process.cwd(), {
			timeoutMs: 50,
		}),
	).rejects.toThrow("timed out");
});

test("timeout kills a TERM-ignoring producer and settles both readers", async () => {
	const started = Date.now();
	await expect(
		captureClaimFeed(
			command(
				`process.on("SIGTERM",()=>{});process.stdout.write("[");process.stderr.write("working");setInterval(()=>{},1000);`,
			),
			process.cwd(),
			{ timeoutMs: 100 },
		),
	).rejects.toThrow("timed out");
	expect(Date.now() - started).toBeLessThan(2000);
});
test("oversize kills a TERM-ignoring producer with both pipes open", async () => {
	const started = Date.now();
	await expect(
		captureClaimFeed(
			command(
				`process.on("SIGTERM",()=>{});process.stderr.write("working");process.stdout.write("x".repeat(5000));setInterval(()=>{},1000);`,
			),
			process.cwd(),
			{ maxBytes: 1024 },
		),
	).rejects.toThrow("exceeds 1024 bytes");
	expect(Date.now() - started).toBeLessThan(2000);
});
