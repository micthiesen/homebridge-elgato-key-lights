import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";
import { Bonjour, type Service as BonjourService } from "bonjour-service";
import { Cause, Data, Effect, Exit, Fiber, Queue, Scope } from "effect";
import { PLATFORM_NAME, PLUGIN_NAME } from "../config/settings.js";
import {
  parseConfig,
  type PluginConfig,
  type DeviceConfig,
} from "../config/validation.js";
import { KeyLightsAccessory } from "../accessories/KeyLightsAccessory.js";
import {
  KeyLightInstance,
  type DeviceDescriptor,
  type DeviceSnapshot,
} from "../devices/KeyLightInstance.js";
import { normalizeMac, validateHost, type Endpoint } from "../protocol/client.js";

class DiscoveryError extends Data.TaggedError("DiscoveryError")<{ cause: unknown }> {}
interface Session {
  device: KeyLightInstance;
  scope: Scope.Closeable;
  started?: boolean;
  handler?: KeyLightsAccessory;
}
type DiscoveryEvent = { service: BonjourService } | { error: unknown };

function endpoints(
  host: string | undefined,
  port: number,
  addresses: readonly string[] = [],
): Endpoint[] {
  return [...new Set([host, ...addresses])]
    .filter(
      (value): value is string => typeof value === "string" && validateHost(value),
    )
    .map((host) => ({ host, port }));
}

/** Owns the application scope. All framework callbacks enter here, never inside device workflows. */
export class KeyLightsPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly config: PluginConfig;
  readonly accessories: PlatformAccessory[] = [];
  private readonly scope = Scope.makeUnsafe();
  private readonly sessions = new Map<string, Session>();
  private readonly serials = new Map<string, Session>();
  private readonly aliases = new Map<string, Session>();
  private stopped = false;
  private started = false;

  constructor(
    readonly log: Logger,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    // Homebridge's constructor is synchronous. Decode once at this external boundary.
    this.config = Effect.runSync(parseConfig(config));
    api.on("didFinishLaunching", () => this.launch(this.start));
    api.on("shutdown", () => {
      void this.shutdown();
    });
  }

  private launch(effect: Effect.Effect<void>): void {
    if (this.stopped) return;
    Effect.runFork(
      effect.pipe(
        Effect.forkIn(this.scope),
        Effect.flatMap(Fiber.join),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!this.stopped) this.log.error(Cause.pretty(cause));
          }),
        ),
      ),
    );
  }

  command<A, E>(device: KeyLightInstance, effect: Effect.Effect<A, E>): Promise<A> {
    const session = [...this.sessions.values()].find((s) => s.device === device);
    if (this.stopped || !session) return Promise.reject(new Error("Plugin stopped"));
    return Effect.runPromise(
      effect.pipe(Effect.forkIn(session.scope), Effect.flatMap(Fiber.join)),
    );
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        for (const session of this.sessions.values()) yield* session.device.stop;
        yield* Scope.close(this.scope, Exit.void);
        this.sessions.clear();
        this.serials.clear();
        this.aliases.clear();
      }),
    );
  }

  private configured(mac?: string, serial?: string): DeviceConfig | undefined {
    return this.config.devices.find(
      (d) => (mac && d.mac === mac) || (serial && d.serialNumber === serial),
    );
  }

  private readonly start = Effect.gen({ self: this }, function* () {
    if (this.stopped || this.started) return;
    this.started = true;
    for (const d of this.config.devices) {
      if (d.enabled === false) continue;
      yield* this.ensure({
        id: d.mac ? `mac:${d.mac}` : `serial:${d.serialNumber}`,
        ...(d.mac ? { mac: d.mac } : {}),
        ...(d.serialNumber ? { serialNumber: d.serialNumber } : {}),
        name: d.displayName?.trim() || d.name || d.mac || d.serialNumber!,
        endpoints: endpoints(d.ip ?? d.host, d.port ?? 9123),
      });
    }
    for (const session of this.sessions.values()) yield* this.startSession(session);
    yield* this.discovery.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!this.stopped && !Cause.hasInterruptsOnly(cause))
            this.log.error(`Discovery stopped: ${Cause.pretty(cause)}`);
        }),
      ),
      Effect.forkIn(this.scope),
    );
  });

  private startSession(session: Session): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (session.started) return;
      session.started = true;
      yield* session.device.supervise.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause))
              this.log.error(`Device supervisor stopped: ${Cause.pretty(cause)}`);
            session.handler?.update();
          }),
        ),
        Effect.forkIn(session.scope),
      );
    });
  }

  private ensure(
    descriptor: DeviceDescriptor,
    accessory?: PlatformAccessory,
  ): Effect.Effect<Session | undefined> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return;
      const settings = this.configured(descriptor.mac, descriptor.serialNumber);
      if (settings?.enabled === false) {
        if (accessory)
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
            accessory,
          ]);
        return;
      }
      const existing =
        this.sessions.get(descriptor.id) ??
        this.aliases.get(descriptor.id) ??
        (descriptor.serialNumber
          ? this.serials.get(descriptor.serialNumber)
          : undefined);
      if (existing) {
        this.aliases.set(descriptor.id, existing);
        if (descriptor.endpoints.length)
          yield* existing.device.updateEndpoints(descriptor.endpoints);
        if (accessory && !existing.handler)
          existing.handler = new KeyLightsAccessory(
            this,
            accessory,
            existing.device,
            accessory.displayName,
          );
        return existing;
      }
      const scope = yield* Scope.fork(this.scope);
      const session: Session = {
        scope,
        device: new KeyLightInstance(
          descriptor,
          this.config,
          settings,
          (device, previous) => this.changed(device, previous),
        ),
      };
      this.sessions.set(descriptor.id, session);
      if (descriptor.serialNumber) this.serials.set(descriptor.serialNumber, session);
      if (accessory)
        session.handler = new KeyLightsAccessory(
          this,
          accessory,
          session.device,
          settings?.displayName?.trim() || accessory.displayName,
        );
      if (this.started) yield* this.startSession(session);
      return session;
    });
  }

  private changed(
    device: KeyLightInstance,
    previous: DeviceSnapshot,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return;
      const session = [...this.sessions.values()].find((s) => s.device === device);
      if (!session) return;
      const snapshot = device.snapshot;
      if (snapshot.status !== previous.status) {
        if (snapshot.status === "online")
          this.log.info(`${device.data.name} is online`);
        else
          this.log.warn(
            `${device.data.name} is offline: ${snapshot.error ?? "unreachable"}; retrying automatically`,
          );
      } else if (!previous.error && snapshot.error)
        this.log.warn(`${device.data.name}: ${snapshot.error}; retrying automatically`);
      if (snapshot.info) {
        const serial = snapshot.info.serialNumber;
        const owner = this.serials.get(serial);
        if (owner && owner !== session) {
          yield* owner.device.updateEndpoints(device.data.endpoints);
          yield* device.stop;
          this.sessions.delete(device.data.id);
          this.aliases.set(device.data.id, owner);
          // Closing from a sibling avoids interrupting/joining the current supervisor itself.
          yield* Scope.close(session.scope, Exit.void).pipe(Effect.forkIn(this.scope));
          return;
        }
        this.serials.set(serial, session);
        if (!session.handler) {
          const uuid = this.api.hap.uuid.generate(serial);
          let accessory = this.accessories.find((a) => a.UUID === uuid);
          const isNew = !accessory;
          const settings = this.configured(device.data.mac, serial);
          const name =
            settings?.displayName?.trim() ||
            snapshot.info.displayName ||
            device.data.name;
          accessory ??= new this.api.platformAccessory(name, uuid);
          session.handler = new KeyLightsAccessory(this, accessory, device, name);
          if (isNew) {
            this.accessories.push(accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
              accessory,
            ]);
          }
        }
        const accessory = session.handler.accessory;
        const context = {
          hostname: device.endpoint?.host,
          port: device.endpoint?.port,
          name: device.data.name,
          mac: device.data.mac,
          serialNumber: serial,
        };
        if (JSON.stringify(accessory.context.device) !== JSON.stringify(context)) {
          accessory.context.device = context;
          this.api.updatePlatformAccessories([accessory]);
        }
      }
      session.handler?.update();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
    const raw: unknown = accessory.context.device;
    if (!raw || typeof raw !== "object") {
      this.log.warn(`Cached accessory ${accessory.displayName} has no device identity`);
      return;
    }
    const data = raw as Record<string, unknown>;
    const mac = normalizeMac(data.mac);
    const savedSerial =
      data.serialNumber ??
      accessory
        .getService(this.Service.AccessoryInformation)
        ?.getCharacteristic(this.Characteristic.SerialNumber).value;
    const serial =
      typeof savedSerial === "string" &&
      savedSerial.trim() &&
      savedSerial.trim().toLowerCase() !== "unknown"
        ? savedSerial.trim()
        : undefined;
    if (!mac && !serial) {
      this.log.warn(`Cached accessory ${accessory.displayName} has invalid identity`);
      return;
    }
    const settings = this.configured(mac, serial);
    const host =
      settings?.ip ??
      settings?.host ??
      (typeof data.hostname === "string" ? data.hostname : undefined);
    const port =
      settings?.port ??
      (typeof data.port === "number" &&
      Number.isInteger(data.port) &&
      data.port > 0 &&
      data.port <= 65535
        ? data.port
        : 9123);
    // Synchronous cache restoration attaches handlers before Homebridge serves any requests.
    Effect.runSync(
      this.ensure(
        {
          id: mac ? `mac:${mac}` : `serial:${serial}`,
          ...(mac ? { mac } : {}),
          ...(serial ? { serialNumber: serial } : {}),
          name: accessory.displayName,
          endpoints: endpoints(host, port),
        },
        accessory,
      ),
    );
  }

  private discovered(service: BonjourService): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const mac = normalizeMac(service.txt?.id);
      if (
        !mac ||
        !Number.isInteger(service.port) ||
        service.port < 1 ||
        service.port > 65535
      )
        return;
      const config = this.configured(mac);
      if (config?.enabled === false) return;
      const candidates =
        config?.ip || config?.host
          ? endpoints(
              config.ip ?? config.host,
              config.port ?? service.port,
              service.addresses,
            )
          : this.config.useIP
            ? endpoints(service.addresses?.[0], service.port, [
                ...(service.addresses ?? []),
                service.host,
              ])
            : endpoints(service.host, service.port, service.addresses);
      yield* this.ensure({
        id: `mac:${mac}`,
        mac,
        name: service.name,
        endpoints: candidates,
      });
    });
  }

  private readonly discovery = Effect.gen({ self: this }, function* () {
    while (!this.stopped) {
      yield* Effect.scoped(
        Effect.gen({ self: this }, function* () {
          const events = yield* Queue.sliding<DiscoveryEvent>(256);
          const bonjour = yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                new Bonjour(undefined, (error: unknown) => {
                  Queue.offerUnsafe(events, { error });
                }),
              catch: (cause) => new DiscoveryError({ cause }),
            }),
            (resource) => Effect.sync(() => resource.destroy()),
          );
          const browser = yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                bonjour.find({ type: "elg" }, (service) => {
                  Queue.offerUnsafe(events, { service });
                }),
              catch: (cause) => new DiscoveryError({ cause }),
            }),
            (resource) =>
              Effect.sync(() => {
                resource.removeAllListeners();
                resource.stop();
              }),
          );
          browser.on("srv-update", (service) => {
            Queue.offerUnsafe(events, { service });
          });
          browser.on("txt-update", (service) => {
            Queue.offerUnsafe(events, { service });
          });
          while (!this.stopped) {
            const event = yield* Effect.raceFirst(
              Queue.take(events),
              Effect.sleep(30000).pipe(Effect.as(undefined)),
            );
            if (!event)
              yield* Effect.try({
                try: () => browser.update(),
                catch: (cause) => new DiscoveryError({ cause }),
              });
            else if ("error" in event)
              return yield* Effect.fail(new DiscoveryError({ cause: event.error }));
            else yield* this.discovered(event.service);
          }
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            this.log.warn(`Discovery failed: ${String(error.cause)}; restarting`),
          ),
        ),
      );
      if (!this.stopped) yield* Effect.sleep(5000);
    }
  });
}
