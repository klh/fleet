// W1052.2.2 probe 2: context windows around thread/start + turn/start
// strings to recover request field names (cwd, model, input, etc).
import { readFileSync } from "node:fs";

const bin = process.argv[2] ?? "/opt/homebrew/bin/codex";
const text = readFileSync(bin).toString("latin1");
for (const needle of ["thread/start", "turn/start", "turn/steer"]) {
	console.log(`\n=== ${needle} ===`);
	let at = 0;
	for (let i = 0; i < 4; i++) {
		const idx = text.indexOf(needle, at);
		if (idx < 0) break;
		const from = Math.max(0, idx - 400);
		const win = text
			.slice(from, idx + 400)
			.replaceAll(/[^\x20-\x7e]/g, " ");
		console.log(`--- @${idx}: ${win}`);
		at = idx + needle.length;
	}
}
