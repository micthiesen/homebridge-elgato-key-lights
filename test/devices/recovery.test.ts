import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Result, Scope } from "effect";
import { TestClock } from "effect/testing";
import { parseConfig } from "../../src/config/validation.js";
import {
  KeyLightInstance,
  type DeviceClient,
  type DeviceSnapshot,
} from "../../src/devices/KeyLightInstance.js";
import {
  DeviceError,
  type DeviceInfo,
  type LightState,
} from "../../src/protocol/client.js";

const first = { host: "192.168.1.10", port: 9123 };
const second = { host: "192.168.1.11", port: 9123 };
const info: DeviceInfo = {
  serialNumber: "serial-one",
  productName: "Elgato Key Light",
  firmwareVersion: "1",
  displayName: "Desk",
  hardwareBoardType: 1,
  firmwareBuildNumber: 1,
  features: [],
};
const initialLight: LightState = { on: 1, brightness: 20, temperature: 213 };
const settings = {
  powerOnBehavior: 1,
  powerOnBrightness: 20,
  powerOnTemperature: 213,
  switchOnDurationMs: 100,
  switchOffDurationMs: 300,
  colorChangeDurationMs: 100,
};
const offline = new DeviceError({ kind: "transport", message: "Disconnected" });

it.effect("retries failed settings writes without claiming unconfirmed settings", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    let actual = settings;
    let writes = 0;
    const { device, online, snapshots } = yield* make(
      client({
        getSettings: () => Effect.sync(() => actual),
        putSettings: (_endpoint, desired) =>
          Effect.gen(function* () {
            if (++writes === 1) {
              yield* Deferred.succeed(attempted, undefined);
              return yield* Effect.fail(offline);
            }
            actual = desired;
          }),
      }),
      { powerOnBrightness: 55 },
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(attempted);
    yield* TestClock.adjust(0);
    expect(device.snapshot.status).toBe("offline");
    expect(device.snapshot.settings).toBeUndefined();
    expect(actual.powerOnBrightness).toBe(20);
    expect(snapshots.some((snapshot) => snapshot.status === "online")).toBe(false);
    yield* TestClock.adjust(1000);
    yield* Deferred.await(online);
    expect(writes).toBe(2);
    expect(device.snapshot.settings?.powerOnBrightness).toBe(55);
    expect(actual.powerOnBrightness).toBe(55);
  }),
);

it.effect(
  "shutdown aborts a pending physical command without publishing a late acknowledgment",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;
      let complete: (() => void) | undefined;
      const { device, online, snapshots } = yield* make(
        client({
          putLight: () =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<void>((resolve) => {
                  complete = resolve;
                  signal.addEventListener(
                    "abort",
                    () => {
                      aborted = true;
                      resolve();
                    },
                    { once: true },
                  );
                  Deferred.doneUnsafe(started, Effect.void);
                }),
              catch: (cause) =>
                new DeviceError({ kind: "transport", message: "Write failed", cause }),
            }),
        }),
      );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* device.supervise.pipe(Effect.forkIn(scope));
      yield* Deferred.await(online);
      const writing = yield* device
        .setProperty({ brightness: 95 })
        .pipe(Effect.forkIn(scope));
      yield* Deferred.await(started);
      yield* device.stop;
      yield* Scope.close(scope, Exit.void);
      expect(Exit.isFailure(yield* Fiber.await(writing))).toBe(true);
      expect(aborted).toBe(true);
      complete?.();
      yield* TestClock.adjust(1000);
      expect(device.snapshot.status).toBe("stopped");
      expect(device.snapshot.light?.brightness).toBe(20);
      expect(snapshots.map((snapshot) => snapshot.light?.brightness)).toEqual([20]);
    }),
);

it.effect(
  "publishes command failure before a subsequent poll can publish success",
  () =>
    Effect.gen(function* () {
      const online = yield* Deferred.make<void>();
      const failurePublishing = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      let reads = 0;
      const config = yield* parseConfig({
        pollingRate: 500,
        requestTimeout: 1000,
        retryMaxDelay: 1000,
      });
      const device = new KeyLightInstance(
        {
          id: "serial:serial-one",
          serialNumber: info.serialNumber,
          name: "Desk",
          endpoints: [first],
        },
        config,
        undefined,
        (device) =>
          Effect.gen(function* () {
            if (device.snapshot.status === "online")
              yield* Deferred.succeed(online, undefined);
            else {
              yield* Deferred.succeed(failurePublishing, undefined);
              yield* Deferred.await(releaseFailure);
            }
          }),
        client({
          getLight: () =>
            Effect.sync(() => {
              reads++;
              return initialLight;
            }),
          putLight: () => Effect.fail(offline),
        }),
      );
      yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(online);
      const command = yield* device
        .setProperty({ brightness: 99 })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(failurePublishing);
      yield* TestClock.adjust(500);
      expect(reads).toBe(1);
      yield* Deferred.succeed(releaseFailure, undefined);
      yield* Fiber.join(command);
      yield* TestClock.adjust(0);
      expect(device.snapshot.status).toBe("online");
    }),
);

it.effect(
  "checks identity before writing even when the old address never went offline",
  () =>
    Effect.gen(function* () {
      let serialNumber = info.serialNumber;
      let writes = 0;
      const { device, online } = yield* make(
        client({
          getInfo: () => Effect.sync(() => ({ ...info, serialNumber })),
          putLight: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
      );
      yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(online);
      serialNumber = "replacement-device";
      const result = yield* device.setProperty({ brightness: 90 }).pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.kind).toBe("identity");
      expect(writes).toBe(0);
      expect(device.snapshot.status).toBe("offline");
    }),
);

it.effect("detects same-address replacement during ordinary polling", () =>
  Effect.gen(function* () {
    let serialNumber = info.serialNumber;
    let reads = 0;
    const { device, online } = yield* make(
      client({
        getInfo: () => Effect.sync(() => ({ ...info, serialNumber })),
        getLight: () =>
          Effect.sync(() => {
            reads++;
            return initialLight;
          }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    serialNumber = "replacement-device";
    yield* TestClock.adjust(500);
    expect(reads).toBe(1);
    expect(device.snapshot.status).toBe("offline");
  }),
);

it.effect(
  "honors disabled serial configuration before settings I/O or registration",
  () =>
    Effect.gen(function* () {
      let settingsReads = 0;
      let writes = 0;
      const { device, snapshots } = yield* make(
        client({
          getSettings: () =>
            Effect.sync(() => {
              settingsReads++;
              return settings;
            }),
          putSettings: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
        {
          powerOnBrightness: 55,
          devices: [{ serialNumber: info.serialNumber, enabled: false }],
        },
      );
      const supervisor = yield* device.supervise.pipe(Effect.forkScoped);
      yield* Fiber.join(supervisor);
      expect(device.snapshot.status).toBe("stopped");
      expect(settingsReads).toBe(0);
      expect(writes).toBe(0);
      expect(snapshots).toEqual([]);
    }),
);

it.effect("applies serial-only settings after verified discovery", () =>
  Effect.gen(function* () {
    let actual = settings;
    const { device, online } = yield* make(
      client({
        getSettings: () => Effect.sync(() => actual),
        putSettings: (_endpoint, value) =>
          Effect.sync(() => {
            actual = value;
          }),
      }),
      { devices: [{ serialNumber: info.serialNumber, powerOnBrightness: 55 }] },
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    expect(actual.powerOnBrightness).toBe(55);
    expect(device.snapshot.settings?.powerOnBrightness).toBe(55);
  }),
);

it.effect("does not write settings after an address revision becomes obsolete", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writes: string[] = [];
    const { device, online } = yield* make(
      client({
        getSettings: (endpoint) =>
          endpoint.host === first.host
            ? Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(settings),
              )
            : Effect.succeed(settings),
        putSettings: (endpoint) =>
          Effect.sync(() => {
            writes.push(endpoint.host);
          }),
      }),
      { powerOnBrightness: 55 },
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(reading);
    yield* device.updateEndpoints([second]);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(online);
    expect(writes).toEqual([second.host]);
  }),
);

it.effect(
  "does not restart healthy polling for duplicate discovery announcements",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const { device, online } = yield* make(
        client({
          getLight: () =>
            Effect.sync(() => {
              reads++;
              return initialLight;
            }),
        }),
      );
      yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(online);
      for (let i = 0; i < 10; i++) yield* device.updateEndpoints([first]);
      yield* TestClock.adjust(100);
      expect(reads).toBe(1);
      yield* TestClock.adjust(400);
      expect(reads).toBe(2);
    }),
);

it.effect("a queue timeout cannot invalidate the active successful session", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const { device, online, snapshots } = yield* make(
      client({
        getLight: () =>
          Effect.gen(function* () {
            if (++reads > 1) {
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(release);
            }
            return initialLight;
          }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    yield* TestClock.adjust(500);
    yield* Deferred.await(reading);
    const command = yield* device
      .setProperty({ brightness: 80 })
      .pipe(Effect.result, Effect.forkScoped);
    yield* TestClock.adjust(300);
    const result = yield* Fiber.join(command);
    expect(Result.isFailure(result) && result.failure.kind).toBe("timeout");
    expect(device.snapshot.status).toBe("online");
    expect(snapshots.some((snapshot) => snapshot.status === "offline")).toBe(false);
    yield* Deferred.succeed(release, undefined);
  }),
);

function client(overrides: Partial<DeviceClient> = {}): DeviceClient {
  return {
    getInfo: () => Effect.succeed(info),
    getLight: () => Effect.succeed(initialLight),
    getSettings: () => Effect.succeed(settings),
    putLight: () => Effect.void,
    putSettings: () => Effect.void,
    identify: () => Effect.void,
    ...overrides,
  };
}

const make = (transport: DeviceClient, overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const config = yield* parseConfig({
      pollingRate: 500,
      requestTimeout: 100,
      retryMaxDelay: 1000,
      ...overrides,
    });
    const online = yield* Deferred.make<void>();
    const snapshots: DeviceSnapshot[] = [];
    const device = new KeyLightInstance(
      {
        id: "serial:serial-one",
        serialNumber: "serial-one",
        name: "Desk",
        endpoints: [first],
      },
      config,
      undefined,
      (device) =>
        Effect.gen(function* () {
          snapshots.push(device.snapshot);
          if (device.snapshot.status === "online")
            yield* Deferred.succeed(online, undefined);
        }),
      transport,
    );
    return { device, online, snapshots };
  });

it.effect("keeps recovering through a long outage with a bounded retry delay", () =>
  Effect.gen(function* () {
    let reachable = false;
    let attempts = 0;
    const { device } = yield* make(
      client({
        getInfo: () =>
          Effect.suspend(() => {
            attempts++;
            return reachable ? Effect.succeed(info) : Effect.fail(offline);
          }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* TestClock.adjust(20_000);
    expect(device.snapshot.status).toBe("offline");
    expect(attempts).toBeGreaterThanOrEqual(20);
    expect(attempts).toBeLessThan(30);
    reachable = true;
    yield* TestClock.adjust(1000);
    expect(device.snapshot.status).toBe("online");
  }),
);

it.effect("rejects a failed write without falsely committing requested values", () =>
  Effect.gen(function* () {
    const { device, online } = yield* make(
      client({ putLight: () => Effect.fail(offline) }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    const result = yield* device.setProperty({ brightness: 100 }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(device.snapshot.status).toBe("offline");
    expect(device.snapshot.light?.brightness).toBe(20);
    yield* TestClock.adjust(500);
    expect(device.snapshot.status).toBe("online");
  }),
);

it.effect("retries failed startup and recovers without a discovery wake", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    let calls = 0;
    const { device, online } = yield* make(
      client({
        getInfo: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* Deferred.succeed(attempted, undefined);
              return yield* Effect.fail(offline);
            }
            return info;
          }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(attempted);
    yield* TestClock.adjust(1000);
    yield* Deferred.await(online);
    expect(calls).toBe(2);
    expect(device.snapshot.status).toBe("online");
  }),
);

it.effect("recovers after an established light disappears at the same IP", () =>
  Effect.gen(function* () {
    let reachable = true;
    let infoReads = 0;
    const { device, online } = yield* make(
      client({
        getInfo: () =>
          Effect.sync(() => {
            infoReads++;
            return info;
          }),
        getLight: () =>
          Effect.suspend(() =>
            reachable ? Effect.succeed(initialLight) : Effect.fail(offline),
          ),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    reachable = false;
    yield* TestClock.adjust(500);
    expect(device.snapshot.status).toBe("offline");
    reachable = true;
    yield* TestClock.adjust(1000);
    expect(device.snapshot.status).toBe("online");
    expect(infoReads).toBe(3);
  }),
);

it.effect("discards an old address response and revalidates the changed endpoint", () =>
  Effect.gen(function* () {
    const readingOld = yield* Deferred.make<void>();
    const releaseOld = yield* Deferred.make<void>();
    const endpoints: string[] = [];
    const { device, online, snapshots } = yield* make(
      client({
        getInfo: (endpoint) =>
          Effect.sync(() => {
            endpoints.push(endpoint.host);
            return info;
          }),
        getLight: (endpoint) =>
          endpoint.host === first.host
            ? Effect.gen(function* () {
                yield* Deferred.succeed(readingOld, undefined);
                yield* Deferred.await(releaseOld);
                return initialLight;
              })
            : Effect.succeed({ ...initialLight, brightness: 90 }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(readingOld);
    yield* device.updateEndpoints([second]);
    yield* Deferred.succeed(releaseOld, undefined);
    yield* Deferred.await(online);
    expect(endpoints).toEqual([first.host, second.host]);
    expect(
      snapshots
        .filter((snapshot) => snapshot.status === "online")
        .map((snapshot) => snapshot.light?.brightness),
    ).toEqual([90]);
  }),
);

it.effect(
  "rejects an address reassigned to a different serial before reading or writing its state",
  () =>
    Effect.gen(function* () {
      const mismatch = yield* Deferred.make<void>();
      let stateReads = 0;
      let writes = 0;
      const { device, online } = yield* make(
        client({
          getInfo: (endpoint) =>
            endpoint.host === first.host
              ? Effect.succeed(info)
              : Deferred.succeed(mismatch, undefined).pipe(
                  Effect.as({ ...info, serialNumber: "some-other-light" }),
                ),
          getLight: () =>
            Effect.sync(() => {
              stateReads++;
              return initialLight;
            }),
          putLight: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
      );
      yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(online);
      yield* device.updateEndpoints([second]);
      yield* Deferred.await(mismatch);
      const command = yield* device.setProperty({ brightness: 99 }).pipe(Effect.result);
      expect(Result.isFailure(command)).toBe(true);
      expect(device.snapshot.status).toBe("offline");
      expect(stateReads).toBe(1);
      expect(writes).toBe(0);
    }),
);

it.effect("serializes a write behind an old poll so the old value cannot win", () =>
  Effect.gen(function* () {
    const polling = yield* Deferred.make<void>();
    const releasePoll = yield* Deferred.make<void>();
    let reads = 0;
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { device, online } = yield* make(
      client({
        getLight: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return initialLight;
            active++;
            maxActive = Math.max(maxActive, active);
            order.push("poll-start");
            yield* Deferred.succeed(polling, undefined);
            yield* Deferred.await(releasePoll);
            order.push("poll-end");
            active--;
            return initialLight;
          }),
        putLight: () =>
          Effect.sync(() => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push("write");
            active--;
          }),
      }),
    );
    yield* device.supervise.pipe(Effect.forkScoped);
    yield* Deferred.await(online);
    yield* TestClock.adjust(500);
    yield* Deferred.await(polling);
    const write = yield* device.setProperty({ brightness: 95 }).pipe(Effect.forkScoped);
    yield* Deferred.succeed(releasePoll, undefined);
    yield* Fiber.join(write);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["poll-start", "poll-end", "write"]);
    expect(device.snapshot.light?.brightness).toBe(95);
  }),
);

it.effect(
  "serializes simultaneous commands and publishes only acknowledged writes",
  () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const writes: number[] = [];
      const { device, online } = yield* make(
        client({
          putLight: (endpoint, patch) =>
            Effect.gen(function* () {
              writes.push(patch.brightness!);
              if (patch.brightness === 30) {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(releaseWrite);
              }
              expect(endpoint).toEqual(first);
            }),
        }),
      );
      yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(online);
      const a = yield* device.setProperty({ brightness: 30 }).pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      const b = yield* device.setProperty({ brightness: 70 }).pipe(Effect.forkScoped);
      expect(device.snapshot.light?.brightness).toBe(20);
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      expect(writes).toEqual([30, 70]);
      expect(device.snapshot.light?.brightness).toBe(70);
    }),
);

it.effect(
  "interrupts held startup resources on shutdown and prevents late publication",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let released = false;
      const { device, snapshots } = yield* make(
        client({
          getInfo: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        }),
      );
      const supervisor = yield* device.supervise.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* device.stop;
      yield* Fiber.interrupt(supervisor);
      yield* TestClock.adjust(100_000);
      yield* device.updateEndpoints([second]);
      const command = yield* device.setProperty({ on: 0 }).pipe(Effect.result);
      expect(released).toBe(true);
      expect(device.snapshot.status).toBe("stopped");
      expect(device.endpoint).toEqual(first);
      expect(snapshots).toEqual([]);
      expect(Result.isFailure(command) && command.failure.kind).toBe("stopped");
    }),
);
