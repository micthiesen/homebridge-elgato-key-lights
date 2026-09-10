import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DeviceError, type DeviceInfo } from "../../src/protocol/client.js";
import { enrichDiscoveredDevices } from "../../src/ui/enrichment.js";
const advertisement = {
  name: "Desk",
  host: "desk.local",
  port: 9123,
  addresses: ["192.0.2.1"],
  mac: "AA:BB:CC:DD:EE:01",
  manufacturer: "Elgato",
  model: "Key Light",
};
const info: DeviceInfo = {
  serialNumber: "serial-1",
  productName: "Key Light",
  firmwareVersion: "1",
  displayName: "Desk",
  firmwareBuildNumber: 1,
  hardwareBoardType: 1,
  features: [],
};
describe("UI discovery identity enrichment", () => {
  it("adds verified serial identity and HTTP reachability", async () => {
    const result = await Effect.runPromise(
      enrichDiscoveredDevices([advertisement], () => Effect.succeed(info)),
    );
    expect(result).toEqual([
      { ...advertisement, serialNumber: "serial-1", online: true },
    ]);
  });
  it("retains the original advertisement when HTTP fails or returns a conflicting MAC", async () => {
    const unavailable = () =>
      Effect.fail(new DeviceError({ kind: "transport", message: "unavailable" }));
    expect(
      await Effect.runPromise(enrichDiscoveredDevices([advertisement], unavailable)),
    ).toEqual([advertisement]);
    expect(
      await Effect.runPromise(
        enrichDiscoveredDevices([advertisement], () =>
          Effect.succeed({ ...info, macAddress: "AA:BB:CC:DD:EE:02" }),
        ),
      ),
    ).toEqual([advertisement]);
  });
  it("returns original advertisements and interrupts probes when its total budget expires", async () => {
    vi.useFakeTimers();
    try {
      let released = false;
      const lookup = () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        );
      const result = Effect.runPromise(
        enrichDiscoveredDevices([advertisement], lookup),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toEqual([advertisement]);
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("limits concurrent probes", async () => {
    let active = 0;
    let maximum = 0;
    const lookup = () =>
      Effect.gen(function* () {
        active++;
        maximum = Math.max(maximum, active);
        yield* Effect.sleep(5);
        active--;
        return info;
      });
    await Effect.runPromise(
      enrichDiscoveredDevices(
        Array.from({ length: 10 }, () => advertisement),
        lookup,
      ),
    );
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });
});
