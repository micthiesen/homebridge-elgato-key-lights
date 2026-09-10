import { isIP } from "node:net";
import { Data, Effect, Schema } from "effect";

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

export interface DeviceInfo {
  readonly serialNumber: string;
  readonly productName: string;
  readonly firmwareVersion: string;
  readonly displayName: string;
  readonly hardwareBoardType: number;
  readonly firmwareBuildNumber: number;
  readonly features: readonly string[];
  readonly macAddress?: string;
}

export interface LightState {
  readonly on: 0 | 1;
  readonly brightness: number;
  /** Device protocol temperature in mirek, not Kelvin. */
  readonly temperature: number;
}

export interface DeviceSettings {
  readonly powerOnBehavior: number;
  readonly powerOnBrightness: number;
  readonly powerOnTemperature: number;
  readonly switchOnDurationMs: number;
  readonly switchOffDurationMs: number;
  readonly colorChangeDurationMs: number;
}

export class DeviceError extends Data.TaggedError("DeviceError")<{
  readonly kind:
    | "transport"
    | "timeout"
    | "http"
    | "protocol"
    | "identity"
    | "unavailable"
    | "stopped";
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {}

export const HTTP_TIMEOUT_MS = 3_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export function normalizeMac(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  if (
    !/^(?:[\da-f]{12}|(?:[\da-f]{2}:){5}[\da-f]{2}|(?:[\da-f]{2}-){5}[\da-f]{2})$/i.test(
      value,
    )
  )
    return undefined;
  const compact = value.replace(/[:-]/g, "").toUpperCase();
  if (compact === "000000000000" || compact === "FFFFFFFFFFFF") return undefined;
  return compact.match(/.{2}/g)!.join(":");
}

/** Accept a hostname or IP literal, never a URL, authority, or shell expression. */
export function validateHost(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || input.length > 253)
    return false;
  if (isIP(input)) return true;
  if (input.startsWith("[") && input.endsWith("]"))
    return isIP(input.slice(1, -1)) === 6;
  // Do not reinterpret malformed numeric IPv4 as an alternate-format IP in URL().
  if (/^[\d.]+$/.test(input)) return false;
  return /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.?$/i.test(
    input,
  );
}

export function endpointUrl(endpoint: Endpoint, path = ""): string {
  if (
    !validateHost(endpoint.host) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    (path !== "" && !/^\/[a-z\d/_-]*$/i.test(path))
  )
    throw new DeviceError({ kind: "protocol", message: "Invalid device endpoint" });
  const host = isIP(endpoint.host) === 6 ? `[${endpoint.host}]` : endpoint.host;
  return `http://${host}:${endpoint.port}${path}`;
}

const boundedInteger = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }));
const brightness = boundedInteger(0, 100);
// HomeKit's narrower 143–344 range is applied only at the HomeKit boundary.
const temperature = boundedInteger(1, 1_000_000);
const duration = boundedInteger(0, 2_147_483_647);
const lightSchema = Schema.Struct({
  on: Schema.Literals([0, 1]),
  brightness,
  temperature,
});
const patchSchema = Schema.Struct({
  on: Schema.optionalKey(Schema.Literals([0, 1])),
  brightness: Schema.optionalKey(brightness),
  temperature: Schema.optionalKey(temperature),
});
export const settingsSchema = Schema.Struct({
  powerOnBehavior: boundedInteger(1, 2),
  powerOnBrightness: brightness,
  powerOnTemperature: temperature,
  switchOnDurationMs: duration,
  switchOffDurationMs: duration,
  colorChangeDurationMs: duration,
});
const infoSchema = Schema.Struct({
  serialNumber: Schema.String,
  productName: Schema.optionalKey(Schema.String),
  firmwareVersion: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  hardwareBoardType: Schema.optionalKey(boundedInteger(0, Number.MAX_SAFE_INTEGER)),
  firmwareBuildNumber: Schema.optionalKey(boundedInteger(0, Number.MAX_SAFE_INTEGER)),
  features: Schema.optionalKey(Schema.Array(Schema.String)),
  macAddress: Schema.optionalKey(Schema.String),
});
const lightsSchema = Schema.Struct({
  numberOfLights: boundedInteger(1, 100),
  lights: Schema.Array(lightSchema),
});

function decode<A>(
  schema: Schema.Decoder<A>,
  value: unknown,
): Effect.Effect<A, DeviceError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceError({ kind: "protocol", message: "Invalid device data", cause }),
    ),
  );
}

/** The only Promise adapter: fetch and consume one bounded HTTP response. */
const request = Effect.fn("Device.request")(function* (
  endpoint: Endpoint,
  path: string,
  method: "GET" | "PUT" | "POST",
  body: unknown,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return yield* Effect.fail(
      new DeviceError({ kind: "protocol", message: "Invalid request timeout" }),
    );
  }
  return yield* Effect.tryPromise({
    try: async (signal): Promise<unknown> => {
      const response = await fetch(endpointUrl(endpoint, path), {
        method,
        signal,
        redirect: "error",
        headers: {
          "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
      });
      const reader = response.body?.getReader();
      try {
        if (!response.ok)
          throw new DeviceError({
            kind: "http",
            message: `Device returned HTTP ${response.status}`,
            status: response.status,
          });
        const declared = Number(response.headers.get("content-length"));
        if (declared > MAX_RESPONSE_BYTES)
          throw new DeviceError({
            kind: "protocol",
            message: "Device response exceeds size limit",
          });
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE_BYTES)
              throw new DeviceError({
                kind: "protocol",
                message: "Device response exceeds size limit",
              });
            chunks.push(chunk.value);
          }
        }
        // PUT/identify commonly acknowledge with an empty body. GET never may.
        if (size === 0 && method !== "GET") return undefined;
        const bytes = Buffer.concat(chunks, size);
        try {
          return JSON.parse(bytes.toString("utf8")) as unknown;
        } catch (cause) {
          throw new DeviceError({
            kind: "protocol",
            message: "Device response is not JSON",
            cause,
          });
        }
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
    },
    catch: (cause) =>
      cause instanceof DeviceError
        ? cause
        : new DeviceError({
            kind: "transport",
            message: "Device request failed",
            cause,
          }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new DeviceError({
            kind: "timeout",
            message: `Device request exceeded ${timeoutMs}ms`,
          }),
        ),
    }),
  );
});

export const getInfo = Effect.fn("Device.getInfo")(function* (
  endpoint: Endpoint,
  timeoutMs = HTTP_TIMEOUT_MS,
): Effect.fn.Return<DeviceInfo, DeviceError> {
  const value = yield* request(
    endpoint,
    "/elgato/accessory-info",
    "GET",
    undefined,
    timeoutMs,
  );
  const info = yield* decode(infoSchema, value);
  const serialNumber = info.serialNumber.trim();
  if (!serialNumber || serialNumber.toLowerCase() === "unknown")
    return yield* Effect.fail(
      new DeviceError({
        kind: "identity",
        message: "Device has no valid serial number",
      }),
    );
  const macAddress =
    info.macAddress === undefined ? undefined : normalizeMac(info.macAddress);
  if (info.macAddress !== undefined && !macAddress)
    return yield* Effect.fail(
      new DeviceError({
        kind: "identity",
        message: "Device returned an invalid MAC address",
      }),
    );
  return {
    serialNumber,
    productName: info.productName ?? "Elgato Key Light",
    firmwareVersion: info.firmwareVersion ?? "",
    displayName: info.displayName ?? "",
    hardwareBoardType: info.hardwareBoardType ?? 0,
    firmwareBuildNumber: info.firmwareBuildNumber ?? 0,
    features: info.features ?? [],
    ...(macAddress ? { macAddress } : {}),
  };
});

export const getLight = Effect.fn("Device.getLight")(function* (
  endpoint: Endpoint,
  timeoutMs = HTTP_TIMEOUT_MS,
): Effect.fn.Return<LightState, DeviceError> {
  const data = yield* decode(
    lightsSchema,
    yield* request(endpoint, "/elgato/lights", "GET", undefined, timeoutMs),
  );
  if (data.lights.length !== data.numberOfLights)
    return yield* Effect.fail(
      new DeviceError({
        kind: "protocol",
        message: "Device light count does not match payload",
      }),
    );
  return data.lights[0]!;
});

export const getSettings = Effect.fn("Device.getSettings")(function* (
  endpoint: Endpoint,
  timeoutMs = HTTP_TIMEOUT_MS,
): Effect.fn.Return<DeviceSettings, DeviceError> {
  return yield* decode(
    settingsSchema,
    yield* request(endpoint, "/elgato/lights/settings", "GET", undefined, timeoutMs),
  );
});

export const putLight = Effect.fn("Device.putLight")(function* (
  endpoint: Endpoint,
  patch: Partial<LightState>,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Effect.fn.Return<void, DeviceError> {
  const validated = yield* decode(patchSchema, patch);
  if (Object.keys(validated).length === 0)
    return yield* Effect.fail(
      new DeviceError({ kind: "protocol", message: "Light update is empty" }),
    );
  yield* request(endpoint, "/elgato/lights", "PUT", { lights: [validated] }, timeoutMs);
});

export const putSettings = Effect.fn("Device.putSettings")(function* (
  endpoint: Endpoint,
  settings: DeviceSettings,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Effect.fn.Return<void, DeviceError> {
  const validated = yield* decode(settingsSchema, settings);
  yield* request(endpoint, "/elgato/lights/settings", "PUT", validated, timeoutMs);
});

export const identify = Effect.fn("Device.identify")(function* (
  endpoint: Endpoint,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Effect.fn.Return<void, DeviceError> {
  yield* request(endpoint, "/elgato/identify", "POST", undefined, timeoutMs);
});
