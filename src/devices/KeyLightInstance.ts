import { Clock, Deferred, Effect, Random, Result, Semaphore } from "effect";
import * as Protocol from "../protocol/client.js";
import type { DeviceConfig, PluginConfig } from "../config/validation.js";
import { configuredSettings } from "../config/validation.js";

export interface DeviceDescriptor {
  id: string;
  mac?: string;
  serialNumber?: string;
  name: string;
  endpoints: readonly Protocol.Endpoint[];
}
export interface DeviceSnapshot {
  readonly status: "offline" | "online" | "stopped";
  readonly info?: Protocol.DeviceInfo;
  readonly light?: Protocol.LightState;
  readonly settings?: Protocol.DeviceSettings;
  readonly lastSeen?: number;
  readonly error?: string;
}
export type DeviceClient = Pick<
  typeof Protocol,
  "getInfo" | "getLight" | "getSettings" | "putLight" | "putSettings" | "identify"
>;

/** A single serialized device session. Its supervisor is owned by the platform scope. */
export class KeyLightInstance {
  private readonly lock = Semaphore.makeUnsafe(1);
  private wake = Deferred.makeUnsafe<void>();
  private revision = 0;
  private candidate = 0;
  private stopped = false;
  private failures = 0;
  private verifiedSerial: string | undefined;
  private current: DeviceSnapshot = { status: "offline" };
  private descriptor: DeviceDescriptor;

  constructor(
    descriptor: DeviceDescriptor,
    readonly config: PluginConfig,
    private readonly deviceConfig: DeviceConfig | undefined,
    private readonly changed: (
      device: KeyLightInstance,
      previous: DeviceSnapshot,
    ) => Effect.Effect<void>,
    private readonly client: DeviceClient = Protocol,
  ) {
    this.descriptor = descriptor;
  }

  get data(): DeviceDescriptor {
    return this.descriptor;
  }
  get snapshot(): DeviceSnapshot {
    return this.current;
  }
  get endpoint(): Protocol.Endpoint | undefined {
    return this.descriptor.endpoints[
      this.candidate % Math.max(1, this.descriptor.endpoints.length)
    ];
  }

  readonly updateEndpoints = (endpoints: readonly Protocol.Endpoint[]) =>
    Effect.sync(() => {
      if (this.stopped || endpoints.length === 0) return;
      if (JSON.stringify(endpoints) !== JSON.stringify(this.descriptor.endpoints)) {
        this.descriptor = { ...this.descriptor, endpoints };
        this.candidate = 0;
        this.revision++;
        this.current = { ...this.current, status: "offline" };
        Deferred.doneUnsafe(this.wake, Effect.void);
      } else if (this.current.status !== "online") {
        Deferred.doneUnsafe(this.wake, Effect.void);
      }
    });

  private publish(snapshot: DeviceSnapshot): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return;
      const previous = this.current;
      this.current = snapshot;
      yield* this.changed(this, previous);
    });
  }

  private refresh = Effect.fn("device.refresh")(function* (this: KeyLightInstance) {
    if (this.stopped) return;
    const endpoint = this.endpoint;
    if (!endpoint)
      return yield* Effect.fail(
        new Protocol.DeviceError({
          kind: "unavailable",
          message: "No known device address",
        }),
      );
    const revision = this.revision;
    const timeout = this.config.requestTimeout;
    const { info, settings: deviceConfig } = yield* this.verify(endpoint, revision);
    if (this.stopped || revision !== this.revision) return;
    let settings = this.current.settings;
    if (this.current.status !== "online" || !settings) {
      settings = yield* this.client.getSettings(endpoint, timeout);
      if (this.stopped || revision !== this.revision) return;
      const desired = configuredSettings(this.config, deviceConfig, settings);
      if (JSON.stringify(desired) !== JSON.stringify(settings)) {
        yield* this.client.putSettings(endpoint, desired, timeout);
        settings = yield* this.client.getSettings(endpoint, timeout);
      }
    }
    const light = yield* this.client.getLight(endpoint, timeout);
    if (this.stopped || revision !== this.revision) return;
    const lastSeen = yield* Clock.currentTimeMillis;
    yield* this.publish({ status: "online", info, light, settings, lastSeen });
    this.failures = 0;
  });

  private verify = Effect.fn("device.verify")(function* (
    this: KeyLightInstance,
    endpoint: Protocol.Endpoint,
    revision: number,
  ) {
    const info = yield* this.client.getInfo(endpoint, this.config.requestTimeout);
    if (this.stopped || revision !== this.revision)
      return yield* Effect.fail(
        new Protocol.DeviceError({
          kind: this.stopped ? "stopped" : "unavailable",
          message: "Device session changed during verification",
        }),
      );
    const expected = this.descriptor.serialNumber ?? this.verifiedSerial;
    if (expected && info.serialNumber !== expected)
      return yield* Effect.fail(
        new Protocol.DeviceError({
          kind: "identity",
          message: "Address belongs to a different device",
        }),
      );
    if (
      this.descriptor.mac &&
      info.macAddress &&
      Protocol.normalizeMac(info.macAddress) !== this.descriptor.mac
    )
      return yield* Effect.fail(
        new Protocol.DeviceError({
          kind: "identity",
          message: "Device MAC does not match configuration",
        }),
      );
    this.verifiedSerial = info.serialNumber;
    const matches = this.config.devices.filter(
      (device) =>
        device.serialNumber === info.serialNumber ||
        (device.mac && device.mac === (this.descriptor.mac ?? info.macAddress)),
    );
    if (
      this.deviceConfig?.enabled === false ||
      matches.some((device) => device.enabled === false)
    ) {
      yield* this.stop;
      return yield* Effect.fail(
        new Protocol.DeviceError({
          kind: "stopped",
          message: "Device is disabled by configuration",
        }),
      );
    }
    const settings =
      matches.find((device) => device.serialNumber === info.serialNumber) ??
      this.deviceConfig ??
      matches[0];
    return { info, settings };
  });

  /** Never exhaust recovery: each failure backs off, each success resets the schedule. */
  readonly supervise = Effect.gen({ self: this }, function* () {
    while (!this.stopped) {
      const result = yield* this.lock.withPermits(1)(
        Effect.gen({ self: this }, function* () {
          const revision = this.revision;
          const result = yield* this.refresh().pipe(Effect.result);
          if (Result.isFailure(result) && !this.stopped && revision === this.revision) {
            this.failures++;
            this.candidate++;
            yield* this.publish({
              ...this.current,
              status: "offline",
              error: result.failure.message,
            });
          }
          return result;
        }),
      );
      if (this.stopped) break;
      let delay = this.config.pollingRate;
      if (Result.isFailure(result)) {
        const jitter = yield* Random.next;
        delay =
          Math.min(
            this.config.retryMaxDelay,
            1000 * 2 ** Math.min(Math.max(0, this.failures - 1), 16),
          ) *
          (0.8 + jitter * 0.2);
      }
      const wake = this.wake;
      yield* Effect.raceFirst(Deferred.await(wake), Effect.sleep(delay));
      if (this.wake === wake) this.wake = Deferred.makeUnsafe<void>();
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        this.stopped = true;
        this.current = { ...this.current, status: "stopped" };
      }),
    ),
  );

  /** Immediate barrier, also wakes the supervisor; scope interruption aborts its requests. */
  readonly stop = Effect.sync(() => {
    this.stopped = true;
    this.revision++;
    this.current = { ...this.current, status: "stopped" };
    Deferred.doneUnsafe(this.wake, Effect.void);
  });

  private command = <A>(
    action: (endpoint: Protocol.Endpoint) => Effect.Effect<A, Protocol.DeviceError>,
  ) =>
    Effect.suspend(() => {
      const timedOut = () =>
        Effect.fail(
          new Protocol.DeviceError({
            kind: "timeout",
            message: "Device command timed out",
          }),
        );
      return this.lock
        .withPermits(1)(
          Effect.gen({ self: this }, function* () {
            const revision = this.revision;
            return yield* Effect.gen({ self: this }, function* () {
              const endpoint = this.endpoint;
              if (this.stopped || this.current.status !== "online" || !endpoint)
                return yield* Effect.fail(
                  new Protocol.DeviceError({
                    kind: this.stopped ? "stopped" : "unavailable",
                    message: "Light is unavailable",
                  }),
                );
              yield* this.verify(endpoint, revision);
              return yield* action(endpoint);
            }).pipe(
              Effect.timeoutOrElse({
                duration: this.config.requestTimeout * 2,
                orElse: timedOut,
              }),
              Effect.tapError((error) =>
                this.stopped || revision !== this.revision
                  ? Effect.void
                  : this.publish({
                      ...this.current,
                      status: "offline",
                      error: error.message,
                    }),
              ),
            );
          }),
        )
        .pipe(
          // A queued caller timing out never changes state owned by the active operation.
          Effect.timeoutOrElse({
            duration: this.config.requestTimeout * 3,
            orElse: timedOut,
          }),
        );
    });

  readonly setProperty = (patch: Partial<Protocol.LightState>) =>
    this.command((endpoint) =>
      Effect.gen({ self: this }, function* () {
        const revision = this.revision;
        yield* this.client.putLight(endpoint, patch, this.config.requestTimeout);
        if (this.stopped || revision !== this.revision)
          return yield* Effect.fail(
            new Protocol.DeviceError({
              kind: "unavailable",
              message: "Device address changed during command",
            }),
          );
        const lastSeen = yield* Clock.currentTimeMillis;
        // Acknowledged absolute values are newer than the last poll. Serialized I/O prevents stale polls reverting them.
        if (this.current.light)
          yield* this.publish({
            ...this.current,
            light: { ...this.current.light, ...patch },
            lastSeen,
          });
      }),
    );

  readonly identify = () =>
    this.command((endpoint) =>
      this.client.identify(endpoint, this.config.requestTimeout),
    );
}
