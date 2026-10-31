// register.ts — W2269.1.4: ONE registration point per workspace (UI law:
// definition/registration split). Modules export classes; this module calls
// customElements.define. Bundled by scripts/build-lit.ts to
// bin/vendor/fleet-local-board.js.
import { FleetLocalBoard } from "./fleet-local-board.ts";

customElements.define("fleet-local-board", FleetLocalBoard);
