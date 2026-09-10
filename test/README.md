# Tests

The plugin uses Vitest. Install dependencies with `pnpm install`, then run:

```bash
pnpm test
pnpm test:coverage
pnpm exec vitest run test/unit/KeyLightInstance.test.ts
pnpm exec vitest run -t 'polling'
pnpm exec vitest
```

`test/unit/` covers device communication, discovery, the device catalog, DNS, and
constants. `test/mocks/` provides Homebridge and Axios mocks;
`test/fixtures/keylight.ts` provides device response factories.

Mock HTTP, DNS, mDNS, and Homebridge boundaries. Automated tests must not contact
real lights or use live credentials. Use fake timers for polling tests and stop
instances, clear mocks, and restore timers after each test. Cover observable
behavior and failure paths rather than reproducing implementation details.

Coverage output is written to `coverage/`. Automated tests do not establish
physical-device compatibility. Use `pnpm dev` for separate local Homebridge and
hardware verification, and report exactly what was exercised.

The complete repository gate is documented in [AGENTS.md](../AGENTS.md).
