import { describe, expect, test } from "vitest";

import {
    createDesktopAuthSecrets,
    createPkceChallenge,
    verifyOAuthState,
} from "./auth-pkce";

describe("desktop OAuth PKCE", () => {
    test("matches the RFC 7636 S256 example", () => {
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

        expect(createPkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    test("creates independent verifier, state, and nonce values", () => {
        const first = createDesktopAuthSecrets();
        const second = createDesktopAuthSecrets();

        expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(first.codeChallenge).toBe(createPkceChallenge(first.codeVerifier));
        expect(first.state).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(second.codeVerifier).not.toBe(first.codeVerifier);
        expect(second.state).not.toBe(first.state);
        expect(second.nonce).not.toBe(first.nonce);
    });

    test("accepts the expected state and rejects mismatches", () => {
        const { state } = createDesktopAuthSecrets();

        expect(verifyOAuthState(state, state)).toBe(true);
        expect(verifyOAuthState(state, `${state}x`)).toBe(false);
        expect(verifyOAuthState(state, state.replace(/^./, state[0] === "a" ? "b" : "a"))).toBe(false);
    });
});
