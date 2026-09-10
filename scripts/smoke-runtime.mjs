import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] || ".");
const plugin = await import(pathToFileURL(resolve(root, "dist/index.js")));
let registration;
plugin.default({
  registerPlatform: (...args) => {
    registration = args;
  },
});
assert.equal(registration[0], "ElgatoKeyLights");
assert.equal(typeof registration[1], "function");
const deadline = setTimeout(() => {
  console.error("Smoke deadline exceeded");
  process.exit(1);
}, 10000);
for (const signal of ["SIGTERM", "disconnect"]) {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = fork(resolve(root, "homebridge-ui/server.js"), [], { silent: true });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const [ready] = await once(child, "message");
  assert.equal(ready.action, "ready");
  const requestArrived = once(server, "request");
  child.send({
    action: "request",
    requestId: 1,
    path: "/device/info",
    body: { host: "127.0.0.1", port: server.address().port },
  });
  await requestArrived;
  const exited = once(child, "exit");
  if (signal === "disconnect") child.disconnect();
  else child.kill(signal);
  const [code, exitSignal] = await exited;
  assert.equal(code, 0, errors || String(exitSignal));
  assert.doesNotMatch(errors, /ERR_IPC_CHANNEL_CLOSED|Unhandled|Cannot find/);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
clearTimeout(deadline);
console.log(
  "PASS: compiled package imports, registers platform, starts UI IPC, and exits cleanly with pending HTTP on SIGTERM/disconnect.",
);
