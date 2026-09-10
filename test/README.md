# Tests

Use Vitest through the pinned pnpm version:

```bash
pnpm test
pnpm test:coverage
pnpm exec vitest run test/ui
```

Tests must not contact real lights, discover the user's network, or use their
Homebridge storage. Protocol/UI integration tests bind local HTTP servers to loopback;
mock Homebridge and mDNS boundaries. Device recovery tests should control transport
failures and time explicitly. Close servers and Effect scopes and restore timers and
mocks after each test.

Cover startup while offline, recovery without discovery, changed endpoints, duplicate
identity, malformed responses, failed writes, request deadlines, serialized I/O, and
shutdown during active work. Browser tests cover hostile device text, verified manual
add, config preservation, and failed/concurrent saves. Keep assertions about observable
behavior rather than copying implementation structure.

The complete gate is in [AGENTS.md](../AGENTS.md). Coverage is written to `coverage/`.
A passing suite or local fake server does not establish physical-device/Wi-Fi recovery.
Run isolated Homebridge and hardware checks separately and report exactly what was
exercised; never claim unperformed hardware verification.

`pnpm build && pnpm test:runtime` loads the compiled plugin and exercises the real UI
child-process IPC boundary, including shutdown with pending HTTP. Pass an extracted
package directory to `node scripts/smoke-runtime.mjs <directory>` to check an npm
tarball installed with production dependencies only. CI runs the compiled smoke
on every supported Node version.
