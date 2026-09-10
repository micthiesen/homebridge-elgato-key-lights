import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { configuredSettings, parseConfig } from "../../src/config/validation.js";
const settings = {
  powerOnBehavior: 1,
  powerOnBrightness: 20,
  powerOnTemperature: 213,
  switchOnDurationMs: 100,
  switchOffDurationMs: 300,
  colorChangeDurationMs: 100,
};
describe("config validation", () => {
  it("preserves current physical settings when no overrides supplied", async () => {
    const config = await Effect.runPromise(parseConfig({}));
    expect(config.pollingRate).toBe(5000);
    expect(configuredSettings(config, undefined, settings)).toEqual(settings);
    expect(
      configuredSettings(
        config,
        { powerOnBrightness: 0, powerOnTemperature: 5000 },
        settings,
      ),
    ).toMatchObject({ powerOnBrightness: 0, powerOnTemperature: 200 });
  });
  it.each([
    { pollingRate: 0 },
    { requestTimeout: -1 },
    { devices: [{ mac: "" }] },
    { devices: [{ mac: "bad" }] },
    { devices: [{ serialNumber: "unknown", ip: "127.0.0.1" }] },
    { devices: [{ serialNumber: " UNKNOWN ", ip: "127.0.0.1" }] },
    { devices: [{ mac: "aa:bb:cc:dd:ee:ff", ip: "http://bad" }] },
    { devices: [{ mac: "AA:BB:CC:DD:EE:FF" }, { mac: "aa-bb-cc-dd-ee-ff" }] },
  ])("rejects unsafe config %j", async (config) => {
    await expect(Effect.runPromise(parseConfig(config))).rejects.toBeDefined();
  });
  it("normalizes legacy blank addresses and trims usable endpoints", async () => {
    const config = await Effect.runPromise(
      parseConfig({
        devices: [
          { mac: "aa:bb:cc:dd:ee:01", ip: "", host: " desk.local " },
          { mac: "aa:bb:cc:dd:ee:02", ip: " 192.0.2.2 ", host: "   " },
          { mac: "aa:bb:cc:dd:ee:03", ip: " ", host: "" },
        ],
      }),
    );
    expect(config.devices[0]).toMatchObject({ ip: undefined, host: "desk.local" });
    expect(config.devices[1]).toMatchObject({ ip: "192.0.2.2", host: undefined });
    expect(config.devices[2]).toMatchObject({ ip: undefined, host: undefined });
  });
  it.each([" http://device.local ", " 999.1.1.1 ", " desk light.local "])(
    "still rejects malformed nonempty address %s",
    async (host) => {
      await expect(
        Effect.runPromise(parseConfig({ devices: [{ serialNumber: "unit", host }] })),
      ).rejects.toThrow("Invalid device host/IP");
    },
  );
  it("accepts a verified manual serial and normalizes MAC", async () => {
    const config = await Effect.runPromise(
      parseConfig({
        devices: [
          { serialNumber: "unit", ip: "127.0.0.1" },
          { mac: "aa-bb-cc-dd-ee-ff" },
        ],
      }),
    );
    expect(config.devices[1].mac).toBe("AA:BB:CC:DD:EE:FF");
  });
  it("removes blank optional identities rather than shadowing verified identity", async () => {
    const config = await Effect.runPromise(
      parseConfig({
        devices: [
          { mac: "aa:bb:cc:dd:ee:ff", serialNumber: " " },
          { mac: " ", serialNumber: "serial-unit" },
        ],
      }),
    );
    expect(config.devices[0].serialNumber).toBeUndefined();
    expect(config.devices[1].mac).toBeUndefined();
    expect(config.devices[1].serialNumber).toBe("serial-unit");
  });
});
