import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const AbsolutePathSchema = z
	.string()
	.refine(isAbsolute, "Absolute path required");
export const LayoutSchema = z.strictObject({
	candidateRoot: AbsolutePathSchema,
	oracleRoot: AbsolutePathSchema,
	outputRoot: AbsolutePathSchema,
});
const within = (parent: string, child: string) => {
	const value = relative(parent, child);
	return (
		value === "" ||
		(!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
	);
};
const disjoint = (roots: string[]) =>
	roots.every((root, index) =>
		roots
			.slice(index + 1)
			.every((other) => !within(root, other) && !within(other, root)),
	);

/** Admit existing host directories. This is a path guard, not a sandbox. */
export async function admitLayout(input: unknown) {
	const supplied = LayoutSchema.parse(input);
	const lexical = Object.values(supplied).map((root) => resolve(root));
	if (!disjoint(lexical))
		throw new Error("Candidate, oracle and output roots must be disjoint");
	const [candidateRoot, oracleRoot, outputRoot] = await Promise.all([
		realpath(supplied.candidateRoot),
		realpath(supplied.oracleRoot),
		realpath(supplied.outputRoot),
	]);
	const canonical = [candidateRoot, oracleRoot, outputRoot];
	if (!disjoint(canonical)) throw new Error("Canonical roots must be disjoint");
	const entries = await Promise.all(canonical.map((root) => stat(root)));
	if (entries.some((entry) => !entry.isDirectory()))
		throw new Error("Admission roots must be directories");
	for (const entry of entries.slice(1)) {
		if (
			(entry.mode & 0o077) !== 0 ||
			(process.getuid && entry.uid !== process.getuid())
		)
			throw new Error(
				"Oracle and output roots must be private to the host owner",
			);
	}
	return { candidateRoot, oracleRoot, outputRoot };
}
