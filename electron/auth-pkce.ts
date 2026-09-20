import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DESKTOP_AUTH_RANDOM_BYTES = 32;

export type DesktopAuthSecrets = {
    codeVerifier: string;
    codeChallenge: string;
    state: string;
    nonce: string;
};

function randomBase64Url(): string {
    return randomBytes(DESKTOP_AUTH_RANDOM_BYTES).toString("base64url");
}

export function createPkceChallenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function createDesktopAuthSecrets(): DesktopAuthSecrets {
    const codeVerifier = randomBase64Url();
    return {
        codeVerifier,
        codeChallenge: createPkceChallenge(codeVerifier),
        state: randomBase64Url(),
        nonce: randomBase64Url(),
    };
}

export function verifyOAuthState(expected: string, received: string): boolean {
    const expectedBytes = Buffer.from(expected, "utf8");
    const receivedBytes = Buffer.from(received, "utf8");
    return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}
