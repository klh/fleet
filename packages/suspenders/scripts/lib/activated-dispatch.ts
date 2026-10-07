import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { probeDispatchSyntax } from "./dispatch-syntax.ts";

export interface ActivatedDispatch {
	state: "ok" | "degraded" | "unknown";
	revision: string | null;
	root: string | null;
	failures: string[];
}

/** Same payload framing as code-only publication; never hashes a checkout. */
export function dispatchPayloadDigest(root: string): string {
	const stableRoot = realpathSync(root);
	const hash = new Bun.CryptoHasher("sha256");
	const files = [
		...new Bun.Glob("**/*").scanSync({ cwd: stableRoot, onlyFiles: true }),
	];
	for (const file of files
		.filter((file) => !file.includes("node_modules/"))
		.sort()) {
		const path = join(stableRoot, file);
		if (!realpathSync(path).startsWith(`${stableRoot}/`))
			throw new Error("payload file escapes its activated generation");
		hash.update(file).update("\0").update(readFileSync(path)).update("\0");
	}
	return hash.digest("hex");
}

/** Receipt-backed observation only. Unknown provenance never authorizes repair. */
export function inspectActivatedDispatch(prefix: string): ActivatedDispatch {
	let revision: string | null = null;
	let root: string | null = null;
	try {
		const active = realpathSync(prefix);
		const receipt = JSON.parse(
			readFileSync(join(active, "harness-receipt.json"), "utf8"),
		);
		if (
			receipt.schema !== "fleet.harness.v1" ||
			typeof receipt.revision !== "string" ||
			typeof receipt.payloadSha256 !== "string" ||
			!/^[a-f0-9]{40}$/.test(receipt.revision) ||
			!/^[a-f0-9]{64}$/.test(receipt.payloadSha256)
		)
			throw new Error("invalid activation receipt");
		revision = receipt.revision;
		root = realpathSync(join(active, ".harness"));
		if (root !== join(active, ".harness"))
			throw new Error("activated payload escapes its generation");
		const expected = join(root, "packages/suspenders/hooks/bin/fleet-loop.ts");
		if (realpathSync(join(prefix, "bin/fleet-loop.ts")) !== expected)
			return {
				state: "degraded",
				revision,
				root,
				failures: ["active dispatch entry escapes the activated generation"],
			};
		if (dispatchPayloadDigest(root) !== receipt.payloadSha256)
			return {
				state: "degraded",
				revision,
				root,
				failures: ["activated payload differs from its publication receipt"],
			};
		const syntax = probeDispatchSyntax(root, prefix);
		return {
			state: syntax.ok ? "ok" : "degraded",
			revision,
			root,
			failures: syntax.failures,
		};
	} catch (error) {
		return {
			state: "unknown",
			revision,
			root: null,
			failures: [`activation integrity unavailable: ${String(error)}`],
		};
	}
}

/** Pin a service to its own generation even after the harness pointer advances. */
export function inspectServiceGeneration(proof: {
	root: string;
	revision: string;
	payloadSha256: string;
}): ActivatedDispatch {
	try {
		if (realpathSync(proof.root) !== proof.root)
			throw new Error("service generation path is not canonical");
		const checked = inspectActivatedDispatch(proof.root);
		if (checked.state !== "ok") return checked;
		const receipt = JSON.parse(
			readFileSync(join(proof.root, "harness-receipt.json"), "utf8"),
		);
		if (
			checked.revision !== proof.revision ||
			receipt.payloadSha256 !== proof.payloadSha256
		)
			return {
				...checked,
				state: "degraded",
				failures: ["service generation differs from activation source proof"],
			};
		return checked;
	} catch {
		return {
			state: "unknown",
			revision: null,
			root: null,
			failures: ["service generation provenance unavailable"],
		};
	}
}
