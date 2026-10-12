// test/fixtures/overlay/entry.ts — W235 CI fixture overlay: the SMALLEST
// safe overlay an enterprise overlay can be — an audit tap + a pinned role
// map, zero network, zero enterprise code. The loader test materializes
// manifest.json (with the real entry digest) beside a copy of this file in
// a temp dir under the test's allow-root, then proves the full path:
// allowlist → manifest validation → version handshake → digest match →
// module load → the loaded module's hooks pass gate registration.
import type {
	AdaptationConfig,
	AuditTapEvent,
} from "../../../src/gov/adaptation.ts";

/** Module-level tap log — the CI test reads it back through the loaded
 *  module (module identity is shared across dynamic imports by URL). */
export const taps: AuditTapEvent[] = [];

/** The fixture surface: audit tap + pinned role map. */
export function createAdaptation(): AdaptationConfig {
	return {
		hooks: {
			audit: (e) => {
				taps.push(e);
			},
		},
		ssoRoles: { fixture: ["buckle:proxy:READ_"] },
	};
}
