import { Bonjour, type Service } from "bonjour-service";
import { Effect } from "effect";
import { DeviceError, normalizeMac, validateHost } from "../protocol/client.js";

export interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  addresses: string[];
  mac: string;
  serialNumber?: string;
  online?: boolean;
  manufacturer: string;
  model: string;
}

/** A short-lived browser owned by the request, released on timeout or interruption. */
export const discoverDevices = (durationMs = 5000) =>
  Effect.gen(function* () {
    const devices = new Map<string, DiscoveredDevice>();
    let bonjour: Bonjour | undefined;
    let browser: ReturnType<Bonjour["find"]> | undefined;
    const cleanup = () => {
      const currentBrowser = browser;
      const currentBonjour = bonjour;
      browser = undefined;
      bonjour = undefined;
      try {
        currentBrowser?.stop();
      } finally {
        currentBonjour?.destroy();
      }
    };
    yield* Effect.callback<never, DeviceError>((resume) => {
      try {
        bonjour = new Bonjour(undefined, (cause: Error) =>
          resume(
            Effect.fail(
              new DeviceError({ kind: "transport", message: cause.message, cause }),
            ),
          ),
        );
        browser = bonjour.find({ type: "elg" }, (service: Service) => {
          const rawMac: unknown = service.txt?.id;
          const mac = normalizeMac(rawMac);
          if (!mac) return;
          if (
            !validateHost(service.host) ||
            !Number.isInteger(service.port) ||
            service.port < 1 ||
            service.port > 65535
          )
            return;
          devices.set(mac, {
            name: service.name,
            host: service.host,
            port: service.port,
            addresses: (service.addresses ?? []).filter(
              (address) => typeof address === "string",
            ),
            mac,
            manufacturer:
              typeof service.txt?.mf === "string" ? service.txt.mf : "Elgato",
            model: typeof service.txt?.md === "string" ? service.txt.md : "Key Light",
          });
        });
      } catch (cause) {
        cleanup();
        resume(
          Effect.fail(
            new DeviceError({
              kind: "transport",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          ),
        );
      }
    }).pipe(Effect.ensuring(Effect.sync(cleanup)), Effect.timeoutOption(durationMs));
    return [...devices.values()];
  });
