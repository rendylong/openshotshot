import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const verifier = join(projectRoot, "scripts", "verify-packaged-brand.mjs");
const cleaner = join(projectRoot, "scripts", "clean-package-output.mjs");
const buildIcon = join(projectRoot, "build", "icon.icns");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
const tempRoots: string[] = [];

async function createPackageFixture({ version = packageVersion, iconFile = "icon.icns" } = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "shotshot-packaging-brand-"));
    tempRoots.push(root);
    const contents = join(root, "mac-arm64", "ShotShot.app", "Contents");
    await mkdir(join(contents, "Resources"), { recursive: true });
    await copyFile(buildIcon, join(contents, "Resources", "icon.icns"));
    await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>ShotShot</string>
<key>CFBundleExecutable</key><string>ShotShot</string>
<key>CFBundleIconFile</key><string>${iconFile}</string>
<key>CFBundleIdentifier</key><string>ai.shotshot.desktop</string>
<key>CFBundleName</key><string>ShotShot</string>
</dict></plist>
`);
    await writeFile(join(root, `ShotShot-${version}-arm64.dmg`), "fixture");
    await writeFile(join(root, `ShotShot-${version}-arm64-mac.zip`), "fixture");
    return root;
}

function runVerifier(distRoot: string) {
    return spawnSync(process.execPath, [verifier], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, SHOTSHOT_DIST_ROOT: distRoot },
    });
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "darwin")("packaged ShotShot brand verification", () => {
    test("accepts artifacts for the current package version", async () => {
        const distRoot = await createPackageFixture();

        const result = runVerifier(distRoot);

        expect(result.status).toBe(0);
    });

    test("rejects stale artifacts from another package version", async () => {
        const distRoot = await createPackageFixture({ version: "9.9.9" });

        const result = runVerifier(distRoot);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`Missing ShotShot-${packageVersion}-arm64.dmg artifact`);
    });

    test("rejects a plist that references a different icon", async () => {
        const distRoot = await createPackageFixture({ iconFile: "other.icns" });

        const result = runVerifier(distRoot);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("CFBundleIconFile: expected icon.icns, received other.icns");
    });
});

describe("package output cleanup", () => {
    test("removes the isolated build output before packaging", async () => {
        const distRoot = await createPackageFixture();

        const result = spawnSync(process.execPath, [cleaner], {
            cwd: projectRoot,
            encoding: "utf8",
            env: { ...process.env, SHOTSHOT_DIST_ROOT: distRoot },
        });

        expect(result.status).toBe(0);
        expect(existsSync(distRoot)).toBe(false);
    });
});
