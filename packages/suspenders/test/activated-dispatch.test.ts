import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	dispatchPayloadDigest,
	inspectActivatedDispatch,
} from "../scripts/lib/activated-dispatch.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "activated-dispatch-"));
	roots.push(root);
	const prefix = join(root, "generation");
	const payload = join(prefix, ".harness");
	write(
		join(payload, "packages/suspenders/hooks/bin/fleet-loop.ts"),
		'throw new Error("must never execute");',
	);
	write(
		join(payload, "packages/suspenders/scripts/dispatch-next.ts"),
		'throw new Error("must never execute");',
	);
	symlinkSync(
		join(payload, "packages/suspenders/hooks/bin"),
		join(prefix, "bin"),
	);
	const receipt = {
		schema: "fleet.harness.v1",
		revision: "a".repeat(40),
		payloadSha256: dispatchPayloadDigest(payload),
		source: join(root, "mutable"),
	};
	write(join(prefix, "harness-receipt.json"), JSON.stringify(receipt));
	return { root, prefix, payload, receipt };
}
test("activated integrity ignores mutable checkout edits and builds without execution", () => {
	const f = fixture();
	write(
		join(f.receipt.source, "packages/suspenders/scripts/dispatch-next.ts"),
		"<<<<<<< broken mutable checkout",
	);
	expect(inspectActivatedDispatch(f.prefix)).toMatchObject({
		state: "ok",
		revision: f.receipt.revision,
		failures: [],
	});
	write(
		join(f.receipt.source, "packages/suspenders/scripts/lib/new-helper.ts"),
		"uncommitted change",
	);
	expect(inspectActivatedDispatch(f.prefix).state).toBe("ok");
});
test("activated byte tampering is degraded instead of installing mutable source", () => {
	const f = fixture();
	write(
		join(f.payload, "packages/suspenders/scripts/dispatch-next.ts"),
		"changed",
	);
	expect(inspectActivatedDispatch(f.prefix)).toMatchObject({
		state: "degraded",
		failures: ["activated payload differs from its publication receipt"],
	});
});
test("missing or malformed receipts remain unknown", () => {
	const f = fixture();
	write(
		join(f.prefix, "harness-receipt.json"),
		JSON.stringify({ ...f.receipt, revision: "HEAD" }),
	);
	expect(inspectActivatedDispatch(f.prefix).state).toBe("unknown");
	rmSync(join(f.prefix, "harness-receipt.json"));
	expect(inspectActivatedDispatch(f.prefix).state).toBe("unknown");
});
test("entry redirection outside the generation is degraded", () => {
	const f = fixture();
	rmSync(join(f.prefix, "bin"));
	write(join(f.root, "outside/fleet-loop.ts"), "export const outside = true;");
	symlinkSync(join(f.root, "outside"), join(f.prefix, "bin"));
	expect(inspectActivatedDispatch(f.prefix).state).toBe("degraded");
});
test("watchdog parity findings cannot invoke installer repair", () => {
	const source = readFileSync(
		new URL("../scripts/dispatch-watchdog.ts", import.meta.url),
		"utf8",
	);
	expect(source).not.toContain("install.sh");
	expect(source).not.toContain("inspectDispatchParity(REPO");
	expect(source).toContain("inspectActivatedDispatch(PREFIX)");
	expect(source).toContain("reapHeaviestMlx()"); // emergency guard remains pending owned actuator work
});
