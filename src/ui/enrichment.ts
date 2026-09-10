import { Effect } from "effect";
import { getInfo, normalizeMac, validateHost } from "../protocol/client.js";
import type { DiscoveredDevice } from "./discovery.js";

/** Learn serial identity before matching manual configuration to an advertisement. */
export const enrichDiscoveredDevices = (
  devices: readonly DiscoveredDevice[],
  lookup: typeof getInfo = getInfo,
) =>
  Effect.gen(function* () {
    const results = [...devices];
    yield* Effect.forEach(
      devices,
      (device, index) =>
        Effect.gen(function* () {
          const candidates = [...new Set([...device.addresses, device.host])]
            .filter(validateHost)
            .slice(0, 4);
          for (const host of candidates) {
            const info = yield* lookup({ host, port: device.port }).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (!info) continue;
            if (info.macAddress && normalizeMac(info.macAddress) !== device.mac)
              continue;
            results[index] = {
              ...device,
              serialNumber: info.serialNumber,
              online: true,
            };
            return;
          }
        }),
      { concurrency: 4, discard: true },
    ).pipe(Effect.timeoutOption(5000));
    // Failed or unfinished probes retain the original mDNS entry, without inventing identity.
    return results;
  });
