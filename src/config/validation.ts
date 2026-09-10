import { Data, Effect, Schema } from "effect";
import { normalizeMac, validateHost, type DeviceSettings } from "../protocol/client.js";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
  cause?: unknown;
}> {}
const integer = (min: number, max: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }));
const optional = Schema.optionalKey;
const overrides = {
  powerOnBehavior: optional(integer(0, 2)),
  powerOnBrightness: optional(integer(0, 100)),
  powerOnTemperature: optional(integer(2900, 7000)),
};
export const DeviceConfigSchema = Schema.Struct({
  mac: optional(Schema.String),
  serialNumber: optional(Schema.String),
  name: optional(Schema.String),
  displayName: optional(Schema.String),
  host: optional(Schema.String),
  ip: optional(Schema.String),
  port: optional(integer(1, 65535)),
  enabled: optional(Schema.Boolean),
  model: optional(Schema.String),
  ...overrides,
});
export type DeviceConfig = typeof DeviceConfigSchema.Type;
const ConfigSchema = Schema.Struct({
  name: optional(Schema.String),
  devices: optional(Schema.Array(DeviceConfigSchema)),
  pollingRate: optional(integer(500, 60000)),
  requestTimeout: optional(integer(100, 10000)),
  retryMaxDelay: optional(integer(1000, 300000)),
  useIP: optional(Schema.Boolean),
  ...overrides,
  switchOnDurationMs: optional(integer(0, 60000)),
  switchOffDurationMs: optional(integer(0, 60000)),
  colorChangeDurationMs: optional(integer(0, 60000)),
});
export type PluginConfig = typeof ConfigSchema.Type & {
  pollingRate: number;
  requestTimeout: number;
  retryMaxDelay: number;
  devices: readonly DeviceConfig[];
};

export const parseConfig = Effect.fn("parseConfig")(function* (value: unknown) {
  const config = yield* Schema.decodeUnknownEffect(ConfigSchema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({ message: "Invalid Key Lights configuration", cause }),
    ),
  );
  const identities = new Set<string>();
  const devices: DeviceConfig[] = [];
  for (const device of config.devices ?? []) {
    const mac = device.mac?.trim() ? normalizeMac(device.mac) : undefined;
    const serialNumber = device.serialNumber?.trim() || undefined;
    if (
      (device.mac?.trim() && !mac) ||
      (!mac && !serialNumber) ||
      serialNumber?.toLowerCase() === "unknown"
    ) {
      return yield* Effect.fail(
        new ConfigError({ message: "Each device needs a valid MAC or serial number" }),
      );
    }
    // Older custom UI versions persisted blank optional addresses.
    const ip = device.ip?.trim() || undefined;
    const host = device.host?.trim() || undefined;
    for (const address of [ip, host]) {
      if (address !== undefined && !validateHost(address))
        return yield* Effect.fail(
          new ConfigError({ message: "Invalid device host/IP" }),
        );
    }
    for (const key of [mac && `mac:${mac}`, serialNumber && `serial:${serialNumber}`]) {
      if (!key) continue;
      if (identities.has(key))
        return yield* Effect.fail(
          new ConfigError({ message: `Duplicate device identity: ${key}` }),
        );
      identities.add(key);
    }
    devices.push({
      ...device,
      ip,
      host,
      mac,
      serialNumber,
    });
  }
  return {
    ...config,
    devices,
    pollingRate: config.pollingRate ?? 5000,
    requestTimeout: config.requestTimeout ?? 3000,
    retryMaxDelay: config.retryMaxDelay ?? 60000,
  } satisfies PluginConfig;
});

/** Only explicit configuration overrides the settings actually confirmed by the device. */
export function configuredSettings(
  config: PluginConfig,
  device: DeviceConfig | undefined,
  current: DeviceSettings,
): DeviceSettings {
  const kelvin = device?.powerOnTemperature ?? config.powerOnTemperature;
  return {
    ...current,
    powerOnBehavior:
      device?.powerOnBehavior || config.powerOnBehavior || current.powerOnBehavior,
    powerOnBrightness:
      device?.powerOnBrightness ??
      config.powerOnBrightness ??
      current.powerOnBrightness,
    powerOnTemperature:
      kelvin === undefined ? current.powerOnTemperature : Math.round(1000000 / kelvin),
    switchOnDurationMs: config.switchOnDurationMs ?? current.switchOnDurationMs,
    switchOffDurationMs: config.switchOffDurationMs ?? current.switchOffDurationMs,
    colorChangeDurationMs:
      config.colorChangeDurationMs ?? current.colorChangeDurationMs,
  };
}
