import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceRequest } from "../../src/ui/requests.js";

let server: Server;
let port: number;
let requests: string[];
beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/elgato/accessory-info")
      res.end(
        JSON.stringify({
          serialNumber: "test-serial",
          productName: "Elgato Key Light",
        }),
      );
    else if (req.url === "/elgato/lights")
      res.end(
        JSON.stringify({
          numberOfLights: 1,
          lights: [{ on: 1, brightness: 50, temperature: 200 }],
        }),
      );
    else if (req.url === "/elgato/lights/settings")
      res.end(
        JSON.stringify({
          powerOnBehavior: 1,
          powerOnBrightness: 50,
          powerOnTemperature: 200,
          switchOnDurationMs: 100,
          switchOffDurationMs: 100,
          colorChangeDurationMs: 100,
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server address");
  port = address.port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("UI device requests over HTTP", () => {
  it("returns verified identity and the browser's settings response contract", async () => {
    const endpoint = { host: "127.0.0.1", port };
    expect(
      await Effect.runPromise(deviceRequest("/device/info", endpoint)),
    ).toMatchObject({ success: true, data: { serialNumber: "test-serial" } });
    expect(
      await Effect.runPromise(deviceRequest("/device/settings", endpoint)),
    ).toMatchObject({
      success: true,
      data: {
        lights: { lights: [{ brightness: 50 }] },
        settings: { powerOnBehavior: 1 },
      },
    });
  });
  it("rejects malformed routes and payloads without issuing network requests", async () => {
    for (const payload of [
      null,
      [],
      { host: "127.0.0.1", port: -1 },
      { host: "http://127.0.0.1", port },
    ]) {
      expect(
        await Effect.runPromise(deviceRequest("/device/info", payload)),
      ).toMatchObject({ success: false });
    }
    expect(
      await Effect.runPromise(
        deviceRequest("/device/settings/update", {
          host: "127.0.0.1",
          port,
          settings: { powerOnBehavior: 999 },
        }),
      ),
    ).toMatchObject({ success: false });
    expect(requests).toEqual([]);
  });
});
