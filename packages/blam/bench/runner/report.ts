// One result JSON record on stdout; diagnostics only on stderr.
import { readFileSync } from "node:fs";
import { readReceipts } from "./contracts.ts";
import { evaluateRunner } from "./evaluate.ts";

if (import.meta.main) {
	try {
		const file = process.argv[2];
		if (!file)
			throw new Error("usage: bun bench/runner/report.ts receipts.ndjson");
		const report = evaluateRunner(readReceipts(readFileSync(file, "utf8")));
		console.log(JSON.stringify(report));
		if (report.issues.length) process.exitCode = 2;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
