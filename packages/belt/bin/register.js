// bin/register.js — W2269.1.2: the belt dashboard's element registry (the
// workspace register the design-ui package will own once it lands; adopted
// here ahead of it). Every dashboard chunk defines its elements through this
// one seam: a double-define throws loudly instead of the old guarded
// `if (!customElements.get(...))` silently skipping, and registeredTags()
// lets a host page or test assert exactly what loaded.
const tags = new Set();

/** Define a custom element exactly once; a re-define attempt throws. */
export function defineElement(tag, ctor) {
	if (tags.has(tag))
		throw new Error(`element "${tag}" already defined by this registry`);
	customElements.define(tag, ctor);
	tags.add(tag);
}

/** Tags defined through this registry, in definition order. */
export function registeredTags() {
	return [...tags];
}
