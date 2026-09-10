# Homebridge Elgato Key Lights

Personal fork published as `@micthiesen/homebridge-elgato-key-lights`. Bridges
Elgato lights into HomeKit through Homebridge, with mDNS discovery and polling.

## Development

Use pnpm (the version pinned in `package.json`), Node 22, 24, or 26, TypeScript 7,
Oxlint, Oxfmt, Vitest, and the pinned Effect v4 release. This is a Node ESM plugin with compiled output in `dist/`.
Keep the Homebridge plugin and custom UI contracts intact.

After changes, run the complete validation gate:

```bash
pnpm check:write
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm test:runtime
```

Use `pnpm test:coverage` for coverage and `pnpm dev` for an isolated local
Homebridge instance. Do not use the user's normal Homebridge storage or globally
link the development checkout. Tests use local HTTP servers and mocked Homebridge
and mDNS boundaries. Close scopes, servers, and timers after each test. Real hardware verification is
separate from the automated gate and must be reported accurately.

## Architecture

- `src/index.ts`: Homebridge platform registration.
- `src/platform/`: discovery, accessory identity reconciliation, scoped supervisors.
- `src/devices/KeyLightInstance.ts`: state, endpoint candidates, retry schedule,
  serialized polling and commands.
- `src/protocol/client.ts`: fetch, request deadlines, response limits, Effect schemas,
  and tagged device failures.
- `src/accessories/KeyLightsAccessory.ts`: HomeKit callbacks and availability updates.
- `src/config/`: configuration schemas, defaults, Kelvin/mirek conversion.
- `src/ui/`: typed Effect custom UI requests and scoped discovery.
- `homebridge-ui/`: tiny server loader and browser DOM adapter.
- `config.schema.json`: Homebridge configuration form contract.
- `test/`: unit and local integration regression tests.

Preserve `ElgatoKeyLights` and existing serial-derived accessory UUIDs. Normalize
MAC identities and reconcile serial-only manual devices without duplicate accessories.
Network failure must not delete accessories or require restarting Homebridge.

Effect owns asynchronous domain work, retries, concurrency, cancellation, and resource
lifetimes. Keep Promise/callback adapters at Homebridge, fetch, and mDNS boundaries.
Use schemas for external data and tagged errors for expected failures. Browser DOM
handlers and the tiny JavaScript UI loader remain framework adapters; do not add
Effect wrappers around pure transformations or rendering. Per-device I/O is serialized;
shutdown interrupts outstanding work and releases every owned resource. Keep Kelvin
configuration and mirek device/HomeKit values explicit.

## Conventions

- Follow the local Oxc configuration: 88 columns and two-space indentation.
- Prefer strong types, explicit boundary validation, and focused modules.
- Do not leave debug logging, commented-out code, or unnecessary abstractions.
- Use `../omni-notify` for evolving TypeScript and Oxc conventions and
  `../homebridge-kasa` for Homebridge packaging and CI patterns. Adapt their
  conventions to this plugin; service-specific infrastructure does not apply.
- Register shared tooling ports through `.agents/skills/sync/sync-map.json` and
  reciprocal peer maps. Preserve each project's intentional differences.
- Edit this file directly and keep `CLAUDE.md` as its compatibility symlink.
  Keep project skills in `.agents/skills/`. Update these living instructions when
  work establishes a durable convention.

## Delivery

Work on `main` by default. Completed, reviewed, verified work is authorized to be
committed and pushed; preserve unrelated changes. This is a maintained personal
fork, so upstream contribution constraints do not limit refactoring.

CI validates pushes to `main` and pull requests. Publishing is automatic from `main` when
`package.json` names an unpublished version. Follow the README release setup for
npm trusted publishing. Do not bump the version for an unrelated cleanup unless
the task includes a release. Record any missing npm setup as a delivery blocker,
not a reason to leave repository work unfinished.
