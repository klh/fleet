// Shared post-tool path for CLI adapters: preserve file validation and deliver
// the unread WebSocket inbox in the same hook decision.
import { allow, context, feedback, type HookInput } from "../lib/hookio.ts";
import { filesCheck } from "./files.ts";
import { pushedContext } from "./push.ts";

export function postToolGate(hook: HookInput): never {
	const files = filesCheck(hook);
	if (files.kind === "block") {
		process.stderr.write(files.err);
		process.exit(2);
	}
	if (files.kind === "feedback") feedback(files.msg);
	const pushed = pushedContext(hook);
	const notes = [files.kind === "context" ? files.msg : "", pushed].filter(
		Boolean,
	);
	if (notes.length) context(notes.join("\n"), "PostToolUse");
	allow();
}
