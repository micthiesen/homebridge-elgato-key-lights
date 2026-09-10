import { Clock, Effect, Schema } from "effect";
import {
  getInfo,
  getLight,
  getSettings,
  putSettings,
  identify,
  DeviceError,
  settingsSchema,
  validateHost,
} from "../protocol/client.js";

const requestSchema = Schema.Struct({
  host: Schema.String.check(Schema.makeFilter(validateHost)),
  port: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 65535 }),
  ),
  settings: Schema.optionalKey(Schema.Unknown),
});
const parseRequest = (payload: unknown) =>
  Schema.decodeUnknownEffect(requestSchema)(payload).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceError({ kind: "protocol", message: "Invalid device request", cause }),
    ),
  );

export const deviceRequest = (route: string, payload: unknown) =>
  Effect.gen(function* () {
    const { host, port, settings } = yield* parseRequest(payload);
    const endpoint = { host, port };
    switch (route) {
      case "/device/info":
        return { data: yield* getInfo(endpoint) };
      case "/device/settings": {
        const [light, currentSettings] = yield* Effect.all(
          [getLight(endpoint), getSettings(endpoint)],
          { concurrency: 2 },
        );
        return { data: { lights: { lights: [light] }, settings: currentSettings } };
      }
      case "/device/settings/update": {
        const validated = yield* Schema.decodeUnknownEffect(settingsSchema)(
          settings,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DeviceError({
                kind: "protocol",
                message: "Invalid settings request",
                cause,
              }),
          ),
        );
        yield* putSettings(endpoint, validated);
        return {};
      }
      case "/device/identify":
        yield* identify(endpoint);
        return {};
      case "/device/test": {
        const start = yield* Clock.currentTimeMillis;
        const info = yield* getInfo(endpoint);
        const end = yield* Clock.currentTimeMillis;
        return {
          latency: end - start,
          deviceName: info.displayName || info.productName,
        };
      }
      default:
        return yield* Effect.fail(
          new DeviceError({ kind: "protocol", message: "Unknown device operation" }),
        );
    }
  }).pipe(
    Effect.timeout(10000),
    Effect.map((result) => ({ success: true as const, ...result })),
    Effect.catch((error) =>
      Effect.succeed({ success: false as const, error: error.message }),
    ),
  );
