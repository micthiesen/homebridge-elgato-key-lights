import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => Promise<unknown>>(),
  cleanup: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("@homebridge/plugin-ui-utils", () => ({
  HomebridgePluginUiServer: class {
    onRequest(path: string, handler: (payload?: unknown) => Promise<unknown>) {
      state.handlers.set(path, handler);
    }
    ready() {}
  },
}));
vi.mock("../../src/ui/discovery.js", () => ({
  discoverDevices: () => Effect.never.pipe(Effect.ensuring(Effect.sync(state.cleanup))),
}));
vi.mock("../../src/ui/requests.js", () => ({
  deviceRequest: () => Effect.succeed({ success: true }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("UI server process boundary", () => {
  it.each(["SIGTERM", "SIGINT", "disconnect"])(
    "interrupts requests and awaits finalizers on %s",
    async (signal) => {
      vi.resetModules();
      const callbacks = new Map<string | symbol, (...args: unknown[]) => void>();
      vi.spyOn(process, "once").mockImplementation((event, listener) => {
        callbacks.set(event, listener);
        return process;
      });
      vi.spyOn(process, "exit").mockImplementation(() => {
        state.exit();
        return undefined as never;
      });
      await import("../../src/ui/server.js");
      const pending = state.handlers.get("/discover")!();
      const rejection = expect(pending).rejects.toBeDefined();
      callbacks.get(signal)!();
      await rejection;
      await vi.waitFor(() => expect(state.exit).toHaveBeenCalledTimes(1));
      expect(state.cleanup).toHaveBeenCalledTimes(1);
      expect(state.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        state.exit.mock.invocationCallOrder[0]!,
      );
    },
  );
});
