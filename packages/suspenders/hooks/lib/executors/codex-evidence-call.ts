import { z } from "zod";
const integer = z.number().int().nonnegative().optional();
const ExecSchema = z.strictObject({
	cmd: z.string(),
	workdir: z.string().optional(),
	yield_time_ms: integer,
	max_output_tokens: integer,
	tty: z.boolean().optional(),
	login: z.boolean().optional(),
	shell: z.string().optional(),
});
const PollSchema = z.strictObject({
	session_id: z.number().int().positive(),
	chars: z.string().optional(),
	yield_time_ms: integer,
	max_output_tokens: integer,
});
const LEXICAL =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const DIRECT =
	/^\s*text\(\s*await tools\.(exec_command|write_stdin)\(\s*\{[^{}]*\}\s*\)\s*\)\s*;?\s*$/;
const STORED =
	/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await tools\.(exec_command|write_stdin)\(\s*\{[^{}]*\}\s*\)\s*;\s*text\(\s*\1(?:\.output)?\s*\)\s*;?\s*$/;
const TEST =
	/^(?:bun\s+(?:(?:--bun\s+)?x\s+playwright\s+test|(?:run\s+)?test)|bunx\s+(?:--bun\s+)?playwright\s+test|npx\s+(?:--yes\s+)?playwright\s+test|playwright\s+test|(?:npm|yarn|pnpm)\s+(?:run\s+)?test|(?:vitest|jest|pytest)|node\s+--test|cargo\s+test|go\s+test)\b/i;
export type EvidenceCall =
	| { kind: "exec"; test: boolean }
	| { kind: "poll"; session: number; readOnly: boolean };

/** Deliberately narrow literal-source grammar. No eval, computed values or extra output. */
export function evidenceCall(source: string): EvidenceCall | null {
	const clean = source.replace(LEXICAL, (token) =>
		token.startsWith('"') || token.startsWith("'") ? token : " ",
	);
	const shape = clean.replace(STRINGS, "STR"),
		direct = DIRECT.exec(shape),
		stored = STORED.exec(shape);
	const kind = direct?.[1] ?? stored?.[2];
	if (!kind) return null;
	const body = /tools\.(?:exec_command|write_stdin)\(\s*\{([\s\S]*)\}\s*\)/
		.exec(clean)?.[1]
		?.trim();
	if (body === undefined) return null;
	const fields: Record<string, unknown> = Object.create(null);
	const field =
		/\s*([A-Za-z_]\w*)\s*:\s*("(?:\\.|[^"\\])*"|(?:0|[1-9]\d*)|true|false)\s*(,|$)/gy;
	let offset = 0;
	while (offset < body.length) {
		field.lastIndex = offset;
		const match = field.exec(body);
		if (!match || Object.hasOwn(fields, match[1])) return null;
		try {
			fields[match[1]] = JSON.parse(match[2]);
		} catch {
			return null;
		}
		offset = field.lastIndex;
	}
	if (kind === "write_stdin") {
		const parsed = PollSchema.safeParse(fields);
		return parsed.success
			? {
					kind: "poll",
					session: parsed.data.session_id,
					readOnly: !parsed.data.chars,
				}
			: null;
	}
	const parsed = ExecSchema.safeParse(fields);
	if (!parsed.success) return null;
	const command = parsed.data.cmd.trim();
	return {
		kind: "exec",
		test: TEST.test(command) && !/[;&|`$\r\n]/.test(command),
	};
}
