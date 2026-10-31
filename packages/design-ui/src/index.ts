// index.ts — W2269.1.1: the @klh/design-ui barrel.
export { KlhEvent } from "./events/klh-event.base.ts";
export {
	ThemeChanged,
	ThemeChangeRequested,
} from "./events/klh-theme.events.ts";
export { defineElement, registeredTags } from "./register.ts";
export { TOKENS, type TokenName } from "./tokens/dist/tokens.ts";
