# Homebridge Elgato Key Lights

Personal fork published as `@micthiesen/homebridge-elgato-key-lights`. Bridges
Elgato lights into HomeKit through Homebridge, with mDNS discovery and polling.

## Development

Use pnpm (the version pinned in `package.json`), Node 22, 24, or 26, TypeScript 7,
Oxlint, Oxfmt, and Vitest. This is a Node ESM plugin with compiled output in `dist/`.
Keep the Homebridge plugin and custom UI contracts intact.

After changes, run the complete validation gate:

```bash
pnpm check:write
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Use `pnpm test:coverage` for coverage and `pnpm dev` for an isolated local
Homebridge instance. Do not use the user's normal Homebridge storage or globally
link the development checkout. Unit tests mock network and Homebridge APIs;
stop polling and restore timers after each test. Real hardware verification is
separate from the automated gate and must be reported accurately.

## Architecture

- `src/index.ts`: Homebridge platform registration.
- `src/platform/`: mDNS discovery, accessory lifecycle, and `DeviceCatalog`.
- `src/devices/KeyLightInstance.ts`: HTTP API, device state, and polling.
- `src/accessories/KeyLightsAccessory.ts`: HomeKit characteristics and updates.
- `src/config/`, `src/types/`, `src/utils/`: identity, constants, shared types, DNS.
- `homebridge-ui/`: configuration UI server and browser assets.
- `config.schema.json`: Homebridge configuration contract.
- `test/`: Vitest unit tests, mocks, and fixtures.

Preserve `ElgatoKeyLights` as the platform identifier and device MAC addresses as
stable identities. Release timers and discovery resources during shutdown. Keep
Kelvin and mirek conversions explicit at protocol boundaries.

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
