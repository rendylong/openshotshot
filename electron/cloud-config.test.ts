import { describe, expect, test } from "vitest";
import { loadShotshotCloudConfig } from "./cloud-config";

describe("Shotshot Cloud runtime configuration", () => {
    test("uses trusted production service origins for a normal packaged launch", () => {
        expect(loadShotshotCloudConfig({})).toEqual({
            accountEnabled: true,
            managedEnabled: true,
            cloudOrigin: "https://api.shotshot.ai",
            webOrigin: "https://shotshot.ai",
            gatewayOrigin: "https://key-mgmt.shotshot.ai",
            diagnostic: null,
        });
    });

    test("accepts exact HTTPS origins for all three services", () => {
        expect(loadShotshotCloudConfig({
            SHOTSHOT_CLOUD_URL: "https://cloud.example",
            SHOTSHOT_WEB_URL: "https://web.example",
            SHOTSHOT_GATEWAY_URL: "https://gateway.example",
        })).toMatchObject({
            accountEnabled: true,
            managedEnabled: true,
            cloudOrigin: "https://cloud.example",
            webOrigin: "https://web.example",
            gatewayOrigin: "https://gateway.example",
            diagnostic: null,
        });
    });

    test.each([
        "http://api.shotshot.ai",
        "https://user:password@api.shotshot.ai",
        "https://api.shotshot.ai/v1",
        "https://api.shotshot.ai?redirect=evil",
    ])("fails closed for an invalid packaged Cloud origin %s", (origin) => {
        expect(loadShotshotCloudConfig({ SHOTSHOT_CLOUD_URL: origin })).toMatchObject({
            accountEnabled: false,
            managedEnabled: false,
            diagnostic: "invalid_cloud_origin",
        });
    });

    test("allows local HTTP origins only in development", () => {
        expect(loadShotshotCloudConfig({
            SHOTSHOT_CLOUD_URL: "http://127.0.0.1:4400",
            SHOTSHOT_WEB_URL: "http://localhost:4321",
            SHOTSHOT_GATEWAY_URL: "http://127.0.0.1:3000",
        }, { development: true })).toMatchObject({
            accountEnabled: true,
            managedEnabled: true,
            diagnostic: null,
        });
    });
});
