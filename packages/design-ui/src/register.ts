// register.ts — W2269.1.1: definition and registration are separate.
// Modules export classes; this is the ONE registration door for
// the workspace: every customElements.define call rides defineElement, so a
// double define fails loudly instead of silently winning.
const defined = new Set<string>();

export const defineElement = (
	tag: string,
	ctor: CustomElementConstructor,
): void => {
	if (customElements.get(tag))
		throw new Error(
			`defineElement: <${tag}> is already defined — ONE register point per workspace`,
		);
	defined.add(tag);
	customElements.define(tag, ctor);
};

export const registeredTags = (): readonly string[] => [...defined];
