import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { Effect } from "effect";
import { discoverDevices } from "./discovery.js";
import { deviceRequest } from "./requests.js";
import { enrichDiscoveredDevices } from "./enrichment.js";

class KeyLightsUiServer extends HomebridgePluginUiServer {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  /** Promise tracking is confined to this child-process/framework boundary. */
  private run<A, E>(work: Effect.Effect<A, E>): Promise<A> {
    const pending = Effect.runPromise(work, { signal: this.controller.signal });
    this.active.add(pending);
    return pending.finally(() => this.active.delete(pending));
  }

  private readonly shutdown = (): void => {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    // Await Effect finalizers before the child process exits, including mDNS cleanup.
    void Promise.allSettled(this.active).then(() => process.exit(0));
  };

  constructor() {
    super();
    process.once("disconnect", this.shutdown);
    process.once("SIGTERM", this.shutdown);
    process.once("SIGINT", this.shutdown);
    for (const route of [
      "/device/info",
      "/device/settings",
      "/device/settings/update",
      "/device/identify",
      "/device/test",
    ]) {
      this.onRequest(route, (payload: unknown) =>
        this.run(deviceRequest(route, payload)),
      );
    }
    this.onRequest("/discover", () =>
      this.run(
        discoverDevices().pipe(
          Effect.flatMap((devices) => enrichDiscoveredDevices(devices)),
        ),
      ),
    );
    this.ready();
  }
}

new KeyLightsUiServer();
