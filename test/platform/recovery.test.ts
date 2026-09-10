import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomebridgeAPI } from "../../node_modules/homebridge/dist/api.js";
import { KeyLightsPlatform } from "../../src/platform/KeyLightsPlatform.js";
import { createMockLogger } from "../mocks/homebridge.js";

const discovery = vi.hoisted(() => ({
  callback: undefined as undefined | ((service: unknown) => void),
  stop: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("bonjour-service", () => ({
  Bonjour: class {
    find(_options: unknown, callback: (service: unknown) => void) {
      discovery.callback = callback;
      return {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        stop: discovery.stop,
        update: vi.fn(),
      };
    }
    destroy = discovery.destroy;
  },
}));
const settings = {
  powerOnBehavior: 1,
  powerOnBrightness: 20,
  powerOnTemperature: 213,
  switchOnDurationMs: 100,
  switchOffDurationMs: 300,
  colorChangeDurationMs: 100,
};
const platforms: KeyLightsPlatform[] = [];
const servers: Server[] = [];
async function deviceServer() {
  const state = {
    ready: false,
    reads: 0,
    writes: 0,
    info: 0,
    brightness: 50,
    serial: "test-serial",
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/elgato/accessory-info") state.info++;
    if (!state.ready) {
      res.writeHead(503).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/elgato/accessory-info")
      res.end(
        JSON.stringify({
          serialNumber: state.serial,
          productName: "Key Light",
          firmwareVersion: "1.0.3",
          displayName: "Test Light",
        }),
      );
    else if (req.url === "/elgato/lights/settings") res.end(JSON.stringify(settings));
    else if (req.method === "PUT") {
      state.writes++;
      let body = "";
      for await (const chunk of req) body += chunk;
      state.brightness = JSON.parse(body).lights[0].brightness;
      res.end();
    } else {
      state.reads++;
      res.end(
        JSON.stringify({
          numberOfLights: 1,
          lights: [{ on: 1, brightness: state.brightness, temperature: 200 }],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { state, port: address.port };
}
function setup(port: number) {
  const api = new HomebridgeAPI();
  const register = vi.spyOn(api, "registerPlatformAccessories");
  const platform = new KeyLightsPlatform(
    createMockLogger(),
    {
      platform: "ElgatoKeyLights",
      pollingRate: 500,
      requestTimeout: 100,
      retryMaxDelay: 1000,
      devices: [{ mac: "aa-bb-cc-dd-ee-ff", ip: "127.0.0.1", port }],
    },
    api,
  );
  platforms.push(platform);
  return { api, platform, register };
}
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.shutdown();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  discovery.callback = undefined;
});

describe("Homebridge recovery with real HTTP and HAP handlers", () => {
  it("recovers a configured device without mDNS and preserves serial UUID through outages", async () => {
    const { state, port } = await deviceServer();
    const { api, platform, register } = setup(port);
    api.signalFinished();
    await expect.poll(() => state.info).toBeGreaterThan(0);
    state.ready = true;
    await expect.poll(() => platform.accessories.length, { timeout: 4000 }).toBe(1);
    const accessory = platform.accessories[0];
    expect(accessory.UUID).toBe(api.hap.uuid.generate("test-serial"));
    const brightness = accessory
      .getService(api.hap.Service.Lightbulb)!
      .getCharacteristic(api.hap.Characteristic.Brightness);
    expect(await brightness.handleGetRequest()).toBe(50);
    await brightness.handleSetRequest(70);
    expect(await brightness.handleGetRequest()).toBe(70);
    state.ready = false;
    await expect
      .poll(() => brightness.statusCode)
      .toBe(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(brightness.handleGetRequest()).rejects.toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    state.ready = true;
    await expect.poll(() => brightness.statusCode, { timeout: 4000 }).toBe(0);
    expect(await brightness.handleGetRequest()).toBe(70);
    expect(register).toHaveBeenCalledTimes(1);
    await platform.shutdown();
    const reads = state.reads;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(state.reads).toBe(reads);
  });

  it("attaches unavailable cached handlers before startup and reuses the existing UUID", async () => {
    const { state, port } = await deviceServer();
    const { api, platform, register } = setup(port);
    const cached = new api.platformAccessory(
      "My Existing Name",
      api.hap.uuid.generate("test-serial"),
    );
    cached.context.device = { mac: "AA:BB:CC:DD:EE:FF", hostname: "127.0.0.1", port };
    cached
      .getService(api.hap.Service.AccessoryInformation)!
      .setCharacteristic(api.hap.Characteristic.SerialNumber, "test-serial");
    platform.configureAccessory(cached);
    const on = cached
      .getService(api.hap.Service.Lightbulb)!
      .getCharacteristic(api.hap.Characteristic.On);
    await expect(on.handleGetRequest()).rejects.toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    api.signalFinished();
    state.ready = true;
    await expect.poll(() => on.statusCode, { timeout: 4000 }).toBe(0);
    expect(register).not.toHaveBeenCalled();
    expect(cached.displayName).toBe("My Existing Name");
    expect(await on.handleGetRequest()).toBe(true);
  });

  it("manual serial/IP config works without mDNS or MAC and ignores duplicate advertisements", async () => {
    const { state, port } = await deviceServer();
    state.ready = true;
    const api = new HomebridgeAPI();
    const register = vi.spyOn(api, "registerPlatformAccessories");
    const platform = new KeyLightsPlatform(
      createMockLogger(),
      {
        platform: "ElgatoKeyLights",
        pollingRate: 500,
        requestTimeout: 100,
        devices: [{ serialNumber: "test-serial", ip: "127.0.0.1", port }],
      },
      api,
    );
    platforms.push(platform);
    api.signalFinished();
    await expect.poll(() => platform.accessories.length).toBe(1);
    for (let i = 0; i < 5; i++)
      discovery.callback?.({
        name: "Discovered",
        host: "127.0.0.1",
        port,
        txt: { id: "AA:BB:CC:DD:EE:FF" },
        addresses: ["127.0.0.1"],
      });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(register).toHaveBeenCalledTimes(1);
    const reads = state.reads;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(state.reads - reads).toBeGreaterThanOrEqual(2);
    expect(state.reads - reads).toBeLessThanOrEqual(3);
  });
  it("does not merge different identities when DHCP reuses a cached address", async () => {
    const { state, port } = await deviceServer();
    state.ready = true;
    state.serial = "replacement-serial";
    const { api, platform, register } = setup(port);
    const cached = new api.platformAccessory(
      "Original",
      api.hap.uuid.generate("original-serial"),
    );
    cached.context.device = {
      mac: "AA:BB:CC:DD:EE:FF",
      serialNumber: "original-serial",
      hostname: "127.0.0.1",
      port,
    };
    platform.configureAccessory(cached);
    api.signalFinished();
    await expect.poll(() => discovery.callback).toBeDefined();
    discovery.callback?.({
      name: "Replacement",
      host: "127.0.0.1",
      port,
      txt: { id: "11:22:33:44:55:66" },
      addresses: ["127.0.0.1"],
    });
    await expect.poll(() => register.mock.calls.length).toBe(1);
    expect(platform.accessories.map((a) => a.UUID)).toEqual([
      api.hap.uuid.generate("original-serial"),
      api.hap.uuid.generate("replacement-serial"),
    ]);
    const on = cached
      .getService(api.hap.Service.Lightbulb)!
      .getCharacteristic(api.hap.Characteristic.On);
    await expect(on.handleGetRequest()).rejects.toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it("does not register a serial-only disabled device discovered by MAC", async () => {
    const { state, port } = await deviceServer();
    state.ready = true;
    const api = new HomebridgeAPI();
    const register = vi.spyOn(api, "registerPlatformAccessories");
    const platform = new KeyLightsPlatform(
      createMockLogger(),
      {
        platform: "ElgatoKeyLights",
        pollingRate: 500,
        requestTimeout: 100,
        devices: [{ serialNumber: "test-serial", enabled: false }],
      },
      api,
    );
    platforms.push(platform);
    api.signalFinished();
    await expect.poll(() => discovery.callback).toBeDefined();
    discovery.callback?.({
      name: "Disabled",
      host: "127.0.0.1",
      port,
      txt: { id: "AA:BB:CC:DD:EE:FF" },
      addresses: ["127.0.0.1"],
    });
    await expect.poll(() => state.info).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(register).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
    expect(state.writes).toBe(0);
  });
});
