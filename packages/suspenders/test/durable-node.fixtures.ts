import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

/** Bun's test launcher puts a node->bun shim first in PATH. Never count it as Node. */
export function realNode(): string {
	const node =
		process.env.FLEET_TEST_NODE_BIN ??
		(process.env.PATH ?? "")
			.split(delimiter)
			.map((dir) => join(dir, "node"))
			.find(
				(file) =>
					existsSync(file) && !basename(realpathSync(file)).startsWith("bun"),
			);
	if (!node)
		throw new Error("Real Node executable required; set FLEET_TEST_NODE_BIN");
	return node;
}
