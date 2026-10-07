export {
	applyQuietOutput,
	quietDefaults,
} from "../skills/quiet-work/scripts/quiet-output.ts";
import { runQuietOutput } from "../skills/quiet-work/scripts/quiet-output.ts";

if (import.meta.main) runQuietOutput(process.argv.slice(2));
