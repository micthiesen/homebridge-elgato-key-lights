import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import {
  DeviceError,
  endpointUrl,
  getInfo,
  getLight,
  getSettings,
  identify,
  MAX_RESPONSE_BYTES,
  normalizeMac,
  putLight,
  putSettings,
  validateHost,
  type Endpoint,
} from "../../src/protocol/client.js";

const servers: Server[] = [];
async function serve(listener: RequestListener): Promise<Endpoint> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { host: "127.0.0.1", port: address.port };
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const state = {
  numberOfLights: 1,
  lights: [{ on: 1, brightness: 60, temperature: 400 }],
};
const settings = {
  powerOnBehavior: 1,
  powerOnBrightness: 20,
  powerOnTemperature: 213,
  switchOnDurationMs: 100,
  switchOffDurationMs: 300,
  colorChangeDurationMs: 100,
};
const failure = <A>(effect: Effect.Effect<A, DeviceError>) =>
  Effect.runPromise(Effect.flip(effect));

describe("device protocol", () => {
  it("reads validated states without narrowing device temperature to HomeKit", async () => {
    const endpoint = await serve((_req, res) => res.end(JSON.stringify(state)));
    await expect(Effect.runPromise(getLight(endpoint))).resolves.toEqual(
      state.lights[0],
    );
  });

  it("allows optional info metadata and normalizes a reported MAC", async () => {
    const endpoint = await serve((_req, res) =>
      res.end(
        JSON.stringify({ serialNumber: " SERIAL ", macAddress: "aa-bb-cc-dd-ee-01" }),
      ),
    );
    await expect(Effect.runPromise(getInfo(endpoint))).resolves.toMatchObject({
      serialNumber: "SERIAL",
      features: [],
      macAddress: "AA:BB:CC:DD:EE:01",
    });
  });

  it.each(["", "unknown", " UNKNOWN "])(
    "rejects unusable serial %j",
    async (serialNumber) => {
      const endpoint = await serve((_req, res) =>
        res.end(JSON.stringify({ serialNumber })),
      );
      expect(await failure(getInfo(endpoint))).toMatchObject({ kind: "identity" });
    },
  );

  it.each([
    "",
    "not JSON",
    JSON.stringify({ numberOfLights: 1, lights: [] }),
    JSON.stringify({ numberOfLights: 2, lights: state.lights }),
    JSON.stringify({
      numberOfLights: 1,
      lights: [{ on: 2, brightness: 10, temperature: 213 }],
    }),
  ])("rejects invalid light responses %j", async (body) => {
    const endpoint = await serve((_req, res) => res.end(body));
    expect(await failure(getLight(endpoint))).toMatchObject({ kind: "protocol" });
  });

  it("validates all physical settings fields", async () => {
    let body: unknown = settings;
    const endpoint = await serve((_req, res) => res.end(JSON.stringify(body)));
    expect(await Effect.runPromise(getSettings(endpoint))).toEqual(settings);
    body = { powerOnBehavior: 1 };
    expect(await failure(getSettings(endpoint))).toMatchObject({ kind: "protocol" });
  });

  it("preserves HTTP failures and refuses redirects", async () => {
    let redirected = false;
    const endpoint = await serve((req, res) => {
      if (req.url === "/elsewhere") redirected = true;
      res.writeHead(503).end("busy");
    });
    expect(await failure(getLight(endpoint))).toMatchObject({
      kind: "http",
      status: 503,
    });
    const redirect = await serve((_req, res) =>
      res.writeHead(302, { location: endpointUrl(endpoint, "/elsewhere") }).end(),
    );
    expect(await failure(getLight(redirect))).toMatchObject({ kind: "transport" });
    expect(redirected).toBe(false);
  });

  it("rejects oversized chunked responses without relying on Content-Length", async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      res.write("x".repeat(MAX_RESPONSE_BYTES));
      res.end("x");
    });
    expect(await failure(getLight(endpoint))).toMatchObject({
      kind: "protocol",
      message: "Device response exceeds size limit",
    });
  });

  it("times out a body that never completes and closes its connection", async () => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const endpoint = await serve((_req, res) => {
      res.on("close", close);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"numberOfLights":');
    });
    expect(await failure(getLight(endpoint, 100))).toMatchObject({ kind: "timeout" });
    await closed;
  });

  it("interrupts in-flight network reads when its caller cancels", async () => {
    let started!: () => void;
    let close!: () => void;
    const receiving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const endpoint = await serve((_req, res) => {
      res.on("close", close);
      res.write("{");
      started();
    });
    const controller = new AbortController();
    const running = Effect.runPromiseExit(getLight(endpoint), {
      signal: controller.signal,
    });
    await receiving;
    controller.abort();
    expect(Exit.isFailure(await running)).toBe(true);
    await closed;
  });

  it("sends validated patches and accepts empty successful mutation replies", async () => {
    const requests: { method?: string; url?: string; body: string }[] = [];
    const endpoint = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(204).end();
      });
    });
    await Effect.runPromise(putLight(endpoint, { brightness: 42 }));
    await Effect.runPromise(putSettings(endpoint, settings));
    await Effect.runPromise(identify(endpoint));
    expect(requests).toEqual([
      {
        method: "PUT",
        url: "/elgato/lights",
        body: JSON.stringify({ lights: [{ brightness: 42 }] }),
      },
      { method: "PUT", url: "/elgato/lights/settings", body: JSON.stringify(settings) },
      { method: "POST", url: "/elgato/identify", body: "" },
    ]);
    expect(await failure(putLight(endpoint, { brightness: Number.NaN }))).toMatchObject(
      { kind: "protocol" },
    );
    expect(await failure(putLight(endpoint, {}))).toMatchObject({ kind: "protocol" });
    expect(
      await failure(putSettings(endpoint, { ...settings, powerOnTemperature: 0 })),
    ).toMatchObject({ kind: "protocol" });
    expect(requests).toHaveLength(3);
  });
});

describe("device identity and endpoints", () => {
  it("normalizes supported MAC formats without accepting missing or bogus identities", () => {
    for (const value of ["aabbccddee01", "aa:bb:cc:dd:ee:01", "aa-bb-cc-dd-ee-01"])
      expect(normalizeMac(value)).toBe("AA:BB:CC:DD:EE:01");
    for (const value of [
      undefined,
      "",
      "unknown",
      "00:00:00:00:00:00",
      "FF:FF:FF:FF:FF:FF",
      "AA:BB",
    ])
      expect(normalizeMac(value)).toBeUndefined();
  });
  it("brackets IPv6 while rejecting arbitrary URLs, credentials and invalid ports", () => {
    expect(endpointUrl({ host: "fe80::1", port: 9123 }, "/elgato/lights")).toBe(
      "http://[fe80::1]:9123/elgato/lights",
    );
    expect(endpointUrl({ host: "[::1]", port: 9123 })).toBe("http://[::1]:9123");
    for (const host of ["keylight.local", "192.168.1.2", "::1"])
      expect(validateHost(host)).toBe(true);
    for (const host of [
      "http://keylight",
      "user@keylight",
      "127.1",
      "keylight/path",
      "keylight?x",
      "$(echo hi)",
      " keylight",
      "",
    ])
      expect(validateHost(host)).toBe(false);
    expect(() => endpointUrl({ host: "keylight", port: 0 })).toThrow(DeviceError);
  });
});
