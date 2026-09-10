import { createServer, type Server } from "node:http";
import { HomebridgeAPI } from "../../node_modules/homebridge/dist/api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyLightsPlatform } from "../../src/platform/KeyLightsPlatform.js";
import { createMockLogger } from "../mocks/homebridge.js";

const bonjourState = vi.hoisted(() => ({
  browser: undefined as
    | { removeAllListeners: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
    | undefined,
  destroy: vi.fn(),
  find: vi.fn(),
}));

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    find() {
      bonjourState.find();
      bonjourState.browser = {
        removeAllListeners: vi.fn(),
        stop: vi.fn(),
      };
      return {
        on: vi.fn(),
        removeAllListeners: bonjourState.browser.removeAllListeners,
        stop: bonjourState.browser.stop,
        update: vi.fn(),
      };
    }

    destroy = bonjourState.destroy;
  },
}));

const platforms: KeyLightsPlatform[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.shutdown();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  bonjourState.browser = undefined;
  bonjourState.destroy.mockClear();
  bonjourState.find.mockClear();
});

describe("platform lifecycle", () => {
  it("releases an active discovery browser and tolerates repeated shutdown", async () => {
    const api = new HomebridgeAPI();
    const platform = new KeyLightsPlatform(
      createMockLogger(),
      { platform: "ElgatoKeyLights" },
      api,
    );
    platforms.push(platform);
    api.signalFinished();
    await expect.poll(() => bonjourState.browser).toBeDefined();
    api.signalFinished();
    await new Promise((resolve) => setImmediate(resolve));
    expect(bonjourState.find).toHaveBeenCalledTimes(1);

    await platform.shutdown();
    await platform.shutdown();

    expect(bonjourState.browser!.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(bonjourState.browser!.stop).toHaveBeenCalledTimes(1);
    expect(bonjourState.destroy).toHaveBeenCalledTimes(1);
  });

  it("interrupts a pending bootstrap without registering a late accessory", async () => {
    let requests = 0;
    const server = createServer((_request, _response) => {
      requests++;
      // Keep the bootstrap request pending until the platform scope is closed.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const api = new HomebridgeAPI();
    const register = vi.spyOn(api, "registerPlatformAccessories");
    const platform = new KeyLightsPlatform(
      createMockLogger(),
      {
        platform: "ElgatoKeyLights",
        requestTimeout: 100,
        pollingRate: 500,
        devices: [{ mac: "aa:bb:cc:dd:ee:ff", ip: "127.0.0.1", port: address.port }],
      },
      api,
    );
    platforms.push(platform);
    api.signalFinished();
    await expect.poll(() => requests).toBeGreaterThan(0);

    await platform.shutdown();
    expect(register).not.toHaveBeenCalled();
    expect(platform.accessories).toHaveLength(0);
  });

  it("registers a healthy device while an independent bootstrap remains stalled", async () => {
    let stalledRequests = 0;
    const stalled = createServer(() => {
      stalledRequests++;
      // Leave the request pending so one device cannot hold up its sibling.
    });
    const healthy = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/elgato/accessory-info") {
        response.end(
          JSON.stringify({
            serialNumber: "healthy-serial",
            productName: "Elgato Key Light",
            firmwareVersion: "1.0",
            displayName: "Healthy Light",
          }),
        );
      } else if (request.url === "/elgato/lights/settings") {
        response.end(
          JSON.stringify({
            powerOnBehavior: 1,
            powerOnBrightness: 20,
            powerOnTemperature: 213,
            switchOnDurationMs: 100,
            switchOffDurationMs: 300,
            colorChangeDurationMs: 100,
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            numberOfLights: 1,
            lights: [{ on: 1, brightness: 20, temperature: 213 }],
          }),
        );
      }
    });
    await Promise.all([
      new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => healthy.listen(0, "127.0.0.1", resolve)),
    ]);
    servers.push(stalled, healthy);
    const stalledAddress = stalled.address();
    const healthyAddress = healthy.address();
    if (
      !stalledAddress ||
      typeof stalledAddress === "string" ||
      !healthyAddress ||
      typeof healthyAddress === "string"
    )
      throw new Error("missing test server port");

    const api = new HomebridgeAPI();
    const register = vi.spyOn(api, "registerPlatformAccessories");
    const platform = new KeyLightsPlatform(
      createMockLogger(),
      {
        platform: "ElgatoKeyLights",
        pollingRate: 500,
        requestTimeout: 100,
        retryMaxDelay: 1000,
        devices: [
          { mac: "aa:bb:cc:dd:ee:01", ip: "127.0.0.1", port: healthyAddress.port },
          { mac: "aa:bb:cc:dd:ee:02", ip: "127.0.0.1", port: stalledAddress.port },
        ],
      },
      api,
    );
    platforms.push(platform);
    api.signalFinished();

    await expect.poll(() => stalledRequests).toBeGreaterThan(0);
    await expect.poll(() => platform.accessories.length, { timeout: 2000 }).toBe(1);
    expect(platform.accessories[0]?.UUID).toBe(api.hap.uuid.generate("healthy-serial"));
    expect(register).toHaveBeenCalledTimes(1);
  });
});
