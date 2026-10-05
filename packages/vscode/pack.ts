// pack.ts — dependency-free vsix packer: Bun.build → stage → zip (native
// CLI, argument arrays). Output: dist/fleet-board-<version>.vsix

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

interface Pkg {
	name: string;
	version: string;
	publisher: string;
	displayName: string;
	description: string;
	engines: { vscode: string };
}

const root = dirname(import.meta.path);
const pkg = (await Bun.file(`${root}/package.json`).json()) as Pkg;

const build = await Bun.build({
	entrypoints: [`${root}/src/extension.ts`],
	outdir: `${root}/out`,
	target: "node",
	format: "cjs",
	external: ["vscode"],
});
if (!build.success) {
	for (const log of build.logs) console.error(log);
	process.exit(1);
}
console.log("built out/extension.js");

const stage = mkdtempSync(`${tmpdir()}/vsix-`);
const ext = `${stage}/extension`;
mkdirSync(ext, { recursive: true });
cpSync(`${root}/package.json`, `${ext}/package.json`);
cpSync(`${root}/README.md`, `${ext}/README.md`);
cpSync(`${root}/icon.svg`, `${ext}/icon.svg`);
cpSync(`${root}/out`, `${ext}/out`, { recursive: true });

writeFileSync(
	`${stage}/[Content_Types].xml`,
	`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/>
<Default Extension=".vsixmanifest" ContentType="text/xml"/>
<Default Extension=".md" ContentType="text/markdown"/>
<Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".svg" ContentType="image/svg+xml"/>
</Types>`,
);

writeFileSync(
	`${stage}/extension.vsixmanifest`,
	`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx/schema/2011">
<Metadata>
<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
<DisplayName>${pkg.displayName}</DisplayName>
<Description xml:space="preserve">${pkg.description}</Description>
<Categories>Other</Categories>
<Properties>
<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/>
</Properties>
</Metadata>
<Installation>
<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
</Installation>
<Dependencies/>
<Assets>
<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
</Assets>
</PackageManifest>`,
);

const dest = `${root}/dist/fleet-board-${pkg.version}.vsix`;
mkdirSync(`${root}/dist`, { recursive: true });
rmSync(dest, { force: true });
const zip = Bun.spawnSync(["zip", "-X", "-r", dest, "."], { cwd: stage });
if (zip.exitCode !== 0) {
	console.error(new TextDecoder().decode(zip.stderr));
	process.exit(1);
}
const list = Bun.spawnSync(["unzip", "-l", dest]);
const names = new TextDecoder().decode(list.stdout);
const need = [
	"extension/package.json",
	"extension.vsixmanifest",
	"[Content_Types].xml",
];
const missing = need.filter((f) => !names.includes(f));
if (missing.length > 0) {
	console.error(`vsix missing entries: ${missing.join(", ")}`);
	process.exit(1);
}
console.log(`packed ${dest}`);
