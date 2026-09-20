import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion, parseVersionParts } from "./version-compare";

describe("parseVersionParts", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseVersionParts("0.18.1")).toEqual([0, 18, 1]);
    expect(parseVersionParts("v0.18.1")).toEqual([0, 18, 1]);
  });
  it("returns null for malformed input", () => {
    expect(parseVersionParts("abc")).toBeNull();
    expect(parseVersionParts("")).toBeNull();
    expect(parseVersionParts("0.18")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("matches legacy semantics", () => {
    expect(isNewerVersion("0.18.2", "0.18.1")).toBe(true);
    expect(isNewerVersion("0.18.1", "0.18.1")).toBe(false);
    expect(isNewerVersion("0.18.0", "0.18.1")).toBe(false);
    expect(isNewerVersion("0.19.0", "0.18.1")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.9")).toBe(true);
  });
  it("ignores prerelease suffix by parsing leading numeric segments", () => {
    expect(isNewerVersion("0.19.0-beta.1", "0.18.1")).toBe(true);
  });
  it("returns false when either side is malformed", () => {
    expect(isNewerVersion("bad", "0.18.1")).toBe(false);
    expect(isNewerVersion("0.18.1", "bad")).toBe(false);
  });
});

describe("compareVersions", () => {
  it("returns ordering", () => {
    expect(compareVersions("0.18.1", "0.18.0")).toBe(1);
    expect(compareVersions("0.18.1", "0.18.1")).toBe(0);
    expect(compareVersions("0.17.9", "1.0.0")).toBe(-1);
  });
  it("returns 0 when either side is malformed (callers sanitize first)", () => {
    expect(compareVersions("bad", "0.18.1")).toBe(0);
  });
});
