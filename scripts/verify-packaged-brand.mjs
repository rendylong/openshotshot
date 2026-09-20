import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(process.env.SHOTSHOT_DIST_ROOT || join(projectRoot, "dist"));
const buildIcon = join(projectRoot, "build", "icon.icns");
const packageMetadata = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const appDirectories = existsSync(distRoot)
    ? readdirSync(distRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
        .map((entry) => join(distRoot, entry.name, "ShotShot.app"))
        .filter(existsSync)
    : [];

if (appDirectories.length !== 1) {
    throw new Error(`Expected one packaged ShotShot.app, found ${appDirectories.length}`);
}

const appDirectory = appDirectories[0];
const plist = join(appDirectory, "Contents", "Info.plist");
const readPlistValue = (key) => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const expectedMetadata = {
    CFBundleDisplayName: "ShotShot",
    CFBundleExecutable: "ShotShot",
    CFBundleIconFile: "icon.icns",
    CFBundleIdentifier: "ai.shotshot.desktop",
    CFBundleName: "ShotShot",
};

for (const [key, expected] of Object.entries(expectedMetadata)) {
    const actual = readPlistValue(key);
    if (actual !== expected) throw new Error(`${key}: expected ${expected}, received ${actual}`);
}

const packagedIcon = join(appDirectory, "Contents", "Resources", expectedMetadata.CFBundleIconFile);
if (!existsSync(packagedIcon)) throw new Error("Packaged ShotShot icon is missing");
if (sha256(packagedIcon) !== sha256(buildIcon)) throw new Error("Packaged icon does not match build/icon.icns");

const appOutputDirectory = basename(dirname(appDirectory));
const architectureSuffix = appOutputDirectory === "mac-arm64"
    ? "-arm64"
    : appOutputDirectory === "mac-universal"
        ? "-universal"
        : appOutputDirectory === "mac"
            ? ""
            : null;
if (architectureSuffix === null) throw new Error(`Unsupported macOS output directory: ${appOutputDirectory}`);

for (const name of [
    `ShotShot-${packageMetadata.version}${architectureSuffix}.dmg`,
    `ShotShot-${packageMetadata.version}${architectureSuffix}-mac.zip`,
]) {
    if (!existsSync(join(distRoot, name))) throw new Error(`Missing ${name} artifact`);
}

console.log("Packaged ShotShot name, bundle identifier, artifacts, and icon are valid.");
