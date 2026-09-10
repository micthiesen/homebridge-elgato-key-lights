import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  destroy: vi.fn(),
  found: undefined as undefined | ((service: unknown) => void),
  error: undefined as undefined | ((error: Error) => void),
}));
vi.mock("bonjour-service", () => ({
  Bonjour: class {
    constructor(_options: unknown, error: (error: Error) => void) {
      mocks.error = error;
    }
    find(_options: unknown, found: (service: unknown) => void) {
      mocks.found = found;
      return { stop: mocks.stop };
    }
    destroy = mocks.destroy;
  },
}));
import { discoverDevices } from "../../src/ui/discovery.js";
afterEach(() => vi.clearAllMocks());

describe("UI discovery lifetime", () => {
  it("deduplicates normalized IDs and releases browser and socket on completion", async () => {
    const result = Effect.runPromise(discoverDevices(30));
    await vi.waitFor(() => expect(mocks.found).toBeTypeOf("function"));
    const device = {
      host: "desk.local",
      name: "Desk",
      port: 9123,
      txt: { id: "AA:BB:CC:DD:EE:01" },
      addresses: ["192.0.2.1"],
    };
    mocks.found!(device);
    mocks.found!({ ...device, txt: { id: "aa-bb-cc-dd-ee-01" } });
    mocks.found!({ ...device, txt: { id: "" } });
    expect(await result).toHaveLength(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("reports mDNS failure and still releases resources", async () => {
    const result = Effect.runPromise(discoverDevices());
    mocks.error!(new Error("socket unavailable"));
    await expect(result).rejects.toThrow("socket unavailable");
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("releases resources when a request is cancelled", async () => {
    const controller = new AbortController();
    const result = Effect.runPromise(discoverDevices(), { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
});
