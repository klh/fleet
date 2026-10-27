// tests/review-eval/inventory.ts — planted-issue inventory handling.
// The inventory (which issue class sits at which line) is machine-local
// private judge truth, never committed. This module only parses and
// validates it against the corpus it claims to describe.
import { readFileSync } from "node:fs";
import { ISSUE_CLASS_SET, type ReviewTask } from "./corpus.ts";

export type InventoryIssue = {
	id: string;
	issueClass: string;
	file: string;
	line: number;
	severity: string;
};

export type Inventory = {
	tasks: Record<string, InventoryIssue[]>;
};

export function loadInventory(path: string): Inventory {
	return JSON.parse(readFileSync(path, "utf8")) as Inventory;
}

/** Validate inventory entries against the corpus they claim to describe. */
export function validateInventory(
	tasks: ReviewTask[],
	inv: Inventory,
): string[] {
	const problems: string[] = [];
	for (const task of tasks) {
		const entries = inv.tasks[task.id];
		if (entries === undefined) {
			problems.push(`inventory missing task ${task.id}`);
			continue;
		}
		const lines = task.content.split("\n");
		for (const e of entries) {
			if (!ISSUE_CLASS_SET.has(e.issueClass)) {
				problems.push(`${e.id}: unknown issueClass ${e.issueClass}`);
			}
			if (e.file !== task.name) {
				problems.push(`${e.id}: file ${e.file} is not ${task.name}`);
			}
			const at = lines[e.line - 1];
			if (at === undefined || at.trim() === "") {
				problems.push(`${e.id}: line ${e.line} empty/absent`);
			}
		}
	}
	return problems;
}
