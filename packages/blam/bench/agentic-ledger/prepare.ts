// CLI wrapper — see prepare-lib.ts for the reusable core.
import { prepareFixture } from "./prepare-lib.ts";

const target = process.argv[2] ?? "";
if (!process.argv[2]) throw new Error("usage: bun prepare.ts <new-directory>");
console.log(prepareFixture(target));
