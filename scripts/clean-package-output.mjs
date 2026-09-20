import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const defaultDistRoot = join(projectRoot, "dist");
const distRoot = resolve(process.env.SHOTSHOT_DIST_ROOT || defaultDistRoot);
const isTestFixture = distRoot.startsWith(`${resolve(tmpdir())}${sep}`) && basename(distRoot).startsWith("shotshot-packaging-brand-");

if (distRoot === parse(distRoot).root || (distRoot !== defaultDistRoot && !isTestFixture)) {
    throw new Error(`Refusing to clean unexpected package output: ${distRoot}`);
}

rmSync(distRoot, { recursive: true, force: true });
console.log(`Cleaned package output: ${distRoot}`);
