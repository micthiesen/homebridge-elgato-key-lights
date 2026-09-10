# Homebridge Elgato Key Lights

Personal fork of [MP Consulting's plugin](https://github.com/mp-consulting/homebridge-elgato-key-lights),
published as [`@micthiesen/homebridge-elgato-key-lights`](https://www.npmjs.com/package/@micthiesen/homebridge-elgato-key-lights).
Controls Elgato Key Light and Key Light Air power, brightness, and color temperature
through Homebridge. Includes mDNS discovery and a Homebridge Config UI X interface.

## Install

Requires Node.js 22.10+, 24, or 26 and Homebridge 1.8+.
Search for `@micthiesen/homebridge-elgato-key-lights` in Homebridge's Plugins tab, or:

```bash
npm install -g @micthiesen/homebridge-elgato-key-lights
```

Add this platform to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ElgatoKeyLights",
      "name": "Elgato Key Lights"
    }
  ]
}
```

Discovery requires reachable `_elg._tcp` mDNS advertisements. In containers or
networks without multicast, use **Add by IP** in the plugin UI. The light must be
reachable for that first add so its serial number can be verified. The saved
address and identity then support startup and recovery without discovery.

The UI shows **Not checked** until it has HTTP evidence; missing mDNS does not mean
a configured light is offline. Open a device to check its current status. Renaming
it preserves unset power-on overrides; moving a settings slider creates an override.

## Configuration

For explicit configuration, identify each device by a valid `mac` or
`serialNumber`. Provide `ip` or `host` to connect without mDNS; identity-only
entries customize devices discovered later.

```json
{
  "platform": "ElgatoKeyLights",
  "name": "Elgato Key Lights",
  "pollingRate": 5000,
  "requestTimeout": 3000,
  "retryMaxDelay": 60000,
  "devices": [
    {
      "serialNumber": "YOUR-LIGHT-SERIAL",
      "ip": "192.0.2.10",
      "port": 9123,
      "displayName": "Desk Light",
      "enabled": true
    }
  ]
}
```

`192.0.2.10` is an example address. Replace it and the serial with your device's values.

| Option | Default | Meaning |
| --- | --- | --- |
| `pollingRate` | `5000` | Delay after successful polling, 500–60000 ms |
| `requestTimeout` | `3000` | Deadline per HTTP call, 100–10000 ms |
| `retryMaxDelay` | `60000` | Maximum recovery delay, 1000–300000 ms |
| `useIP` | `false` | Prefer discovered IP addresses to hostnames |
| `devices` | `[]` | Per-device identity, address, display name, enablement, and power-on settings |
| `powerOnBehavior` | Keep device setting | `1`: restore last state; `2`: use defaults |
| `powerOnBrightness` | Keep device setting | Power-on brightness, 0–100% |
| `powerOnTemperature` | Keep device setting | Power-on temperature, 2900–7000 Kelvin |
| `switchOnDurationMs` | Keep device setting | Fade-in duration, 0–60000 ms |
| `switchOffDurationMs` | Keep device setting | Fade-out duration, 0–60000 ms |
| `colorChangeDurationMs` | Keep device setting | Color transition duration, 0–60000 ms |

Per-device power-on settings override global settings. A per-device
`powerOnBehavior` of `0` inherits the global setting. Omitted settings retain the
values confirmed by the light. Kelvin configuration converts to the device's
mirek protocol at the settings boundary.

Existing HomeKit accessory UUIDs continue to derive from the device serial number.
Recovery does not require removing and re-pairing an accessory.

## Recovery

Each light has an independent Effect supervisor. Failed startup and later
connection failures retry indefinitely. Delays grow exponentially from roughly
one second, with jitter between 80% and 100% of the capped delay. The default
maximum wait is 60 seconds **between attempts**, plus the time spent on requests.
Each request has its own deadline; initialization can make several calls.

Discovery updates address candidates and wakes recovery. The plugin tries
alternate known endpoints instead of permanently pinning an old IP. HTTP calls
for each light are serialized so polling and commands cannot race. Unreachable
lights report communication failure to HomeKit, while last confirmed state stays
available internally. Shutdown interrupts supervised work and releases discovery.

If a light stays unavailable, inspect the Homebridge log, confirm its address and
port (normally `9123`), and check network reachability. DHCP reservations are useful
when multicast is blocked: the plugin cannot discover an entirely new address
without discovery or an updated configuration. A plugin cannot repair a light
that is disconnected from Wi-Fi or not serving its HTTP API.

## Development

Use pinned pnpm, TypeScript 7, Oxlint, Oxfmt, Vitest, and the pinned Effect v4
release. Run the complete gate:

```bash
pnpm install
pnpm check:write
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm test:runtime
```

`pnpm test:coverage` collects coverage. Tests use controlled HTTP servers and mocked
Homebridge/discovery boundaries. These checks do not prove physical light or Wi-Fi
recovery; report real hardware checks separately.

For isolated Homebridge development:

```bash
cp test/hbConfig/config.sample.json test/hbConfig/config.json
pnpm dev
```

Edit the ignored local config first. This uses `test/hbConfig/`, does not globally
link the checkout, and does not launch Config UI X. Discovery can still find and
control actual lights on the local network.

| Path | Responsibility |
| --- | --- |
| `src/platform/` | Homebridge lifecycle, discovery, identity reconciliation, scoped device supervisors |
| `src/devices/` | Device state, retries, endpoint candidates, serialized commands |
| `src/protocol/` | Validated, bounded HTTP API using fetch and Effect |
| `src/accessories/` | HomeKit handlers and availability/state updates |
| `src/config/` | Schema validation, defaults, settings conversion |
| `src/ui/` | Typed Effect custom UI server requests and scoped discovery |
| `homebridge-ui/` | Server loader and browser DOM adapter |
| `test/` | Unit and integration regression tests |

See [AGENTS.md](AGENTS.md) for project conventions and [test/README.md](test/README.md)
for verification rules.

## Releases

GitHub Actions validates pull requests and pushes to `main` on Node.js 22, 24, and
26. A successful `main` run publishes when `package.json` names an unpublished
version. Bump the version deliberately, commit, and push. Verify the **push-triggered**
run and npm version; rerunning an already published version correctly skips it.

This repository uses npm trusted publishing (OIDC), without an `NPM_TOKEN` secret.
For a new fork, enable workflows in GitHub's Actions tab, bootstrap the npm package
once from an authenticated account, and add a GitHub Actions trusted publisher in
npm package settings:

| Field | Value for this repository |
| --- | --- |
| Organization/user | `micthiesen` |
| Repository | `homebridge-elgato-key-lights` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Allowed action | Direct `npm publish` |

The [workflow](.github/workflows/publish.yml) requests the OIDC identity and publishes
with provenance. Never commit npm credentials.

## License and credits

[MIT](LICENSE). Forked from MP Consulting's plugin, originally derived from
[homebridge-keylights](https://github.com/derjayjay/homebridge-keylights) by derjayjay.
