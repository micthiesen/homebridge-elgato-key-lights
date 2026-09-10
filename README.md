# Homebridge Elgato Key Lights

A maintained personal fork of the [upstream plugin](https://github.com/mp-consulting/homebridge-elgato-key-lights).

A [Homebridge](https://homebridge.io) plugin for controlling [Elgato Key Light](https://www.elgato.com/en/key-light) and [Key Light Air](https://www.elgato.com/en/key-light-air) devices via HomeKit.

[![npm](https://img.shields.io/npm/v/@micthiesen/homebridge-elgato-key-lights)](https://www.npmjs.com/package/@micthiesen/homebridge-elgato-key-lights)
[![npm](https://img.shields.io/npm/dt/@micthiesen/homebridge-elgato-key-lights)](https://www.npmjs.com/package/@micthiesen/homebridge-elgato-key-lights)
[![License](https://img.shields.io/npm/l/@micthiesen/homebridge-elgato-key-lights)](LICENSE)

## Features

- Automatic discovery of Elgato Key Lights on your network via mDNS/Bonjour
- Control power, brightness, and color temperature from HomeKit
- Real-time state synchronization with polling
- Configure power-on behavior and default settings
- Custom UI for device management in Homebridge Config UI X

## Requirements

- Node.js 22.10+, 24, or 26
- Homebridge v1.8.0 or later

## Installation

### Via Homebridge Config UI X (Recommended)

1. Open Homebridge Config UI X
2. Navigate to the Plugins tab
3. Search for `@micthiesen/homebridge-elgato-key-lights`
4. Click Install

### Via npm

```bash
npm install -g @micthiesen/homebridge-elgato-key-lights
```

## Configuration

### Basic Configuration

Add the platform to your Homebridge `config.json`:

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

That's it! The plugin will automatically discover all Elgato Key Lights on your network.

### Advanced Configuration

```json
{
  "platforms": [
    {
      "platform": "ElgatoKeyLights",
      "name": "Elgato Key Lights",
      "pollingRate": 1000,
      "powerOnBehavior": 1,
      "powerOnBrightness": 20,
      "powerOnTemperature": 4695,
      "switchOnDurationMs": 100,
      "switchOffDurationMs": 300,
      "colorChangeDurationMs": 100,
      "useIP": false,
      "devices": [
        {
          "mac": "AA:BB:CC:DD:EE:FF",
          "displayName": "Desk Light"
        },
        {
          "mac": "11:22:33:44:55:66",
          "displayName": "Studio Key Light"
        }
      ]
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | `"Elgato Key Lights"` | Plugin name displayed in Homebridge logs |
| `pollingRate` | integer | `1000` | How often to poll light status (milliseconds) |
| `powerOnBehavior` | integer | `1` | `1` = Restore last settings, `2` = Restore defaults |
| `powerOnBrightness` | integer | `20` | Default brightness when powered on (0-100%) |
| `powerOnTemperature` | integer | `4695` | Default color temperature (2900-7000K) |
| `switchOnDurationMs` | integer | `100` | Fade-in duration when turning on (ms) |
| `switchOffDurationMs` | integer | `300` | Fade-out duration when turning off (ms) |
| `colorChangeDurationMs` | integer | `100` | Transition duration for color changes (ms) |
| `useIP` | boolean | `false` | Use IP address instead of hostname for connections |
| `devices` | array | `[]` | Per-device configuration (see below) |

### Per-Device Configuration

The `devices` array allows you to customize individual lights:

| Option | Type | Description |
|--------|------|-------------|
| `mac` | string | MAC address of the device |
| `displayName` | string | Custom display name for HomeKit |

You can find the MAC address in Homebridge logs when a device is discovered.

## Supported Devices

- Elgato Key Light
- Elgato Key Light Air
- Elgato Key Light Mini
- Elgato Ring Light

Any device advertising the `_elg._tcp` mDNS service should work.

## Troubleshooting

### Lights not discovered

1. Ensure your lights are on the same network as your Homebridge server
2. Check that mDNS/Bonjour traffic is not blocked by your router or firewall
3. Try enabling the `useIP` option if you have DNS resolution issues

### Connection issues

If you experience intermittent connection problems:

1. Try setting `useIP: true` in your configuration
2. Assign static IP addresses to your lights via your router's DHCP settings
3. Increase `pollingRate` to poll less frequently if your network is congested

### Lights not responding

1. Restart the Elgato Control Center app on your computer
2. Power cycle your Key Light
3. Check the Homebridge logs for error messages

## Development

Use the pnpm version pinned in `package.json` and a supported Node.js version.
The plugin builds with TypeScript 7; Oxlint and Oxfmt enforce the shared
TypeScript conventions used in `../omni-notify`.

```bash
git clone https://github.com/micthiesen/homebridge-elgato-key-lights.git
cd homebridge-elgato-key-lights
pnpm install
pnpm check:write
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check:write` applies lint fixes and formatting. `pnpm check` verifies lint
and formatting without modifying files. `pnpm test:coverage` generates coverage.
For the first local run, create the development configuration:

```bash
cp test/hbConfig/config.sample.json test/hbConfig/config.json
```

Edit that local file as needed; it is ignored by Git.
`pnpm dev` rebuilds on changes and runs Homebridge with this checkout as its
plugin path and `test/hbConfig/` as its local storage directory. It does not use
your normal Homebridge configuration or require a global npm link. It does not
launch Homebridge Config UI X. Local discovery can still find real lights on your
network.

See [AGENTS.md](AGENTS.md) for architecture and contributor conventions and
[test/README.md](test/README.md) for test isolation rules.

## Releases

GitHub Actions validates pull requests and pushes to `main` on Node.js 22, 24,
and 26.
Successful CI on `main` publishes an npm version when the version in
`package.json` has not already been published. Bump that version deliberately,
commit, and push to release. Repeated pushes with the same published version skip
publishing. The package is public under the `@micthiesen` scope.

The repository contains the [publishing workflow](.github/workflows/publish.yml),
but npm account setup must be completed before automatic publishing can succeed:

1. If the package does not yet exist, publish it once from an authenticated npm
   account with access to the `@micthiesen` scope: run the validation commands
   above, then `npm publish --access public`.
2. In the npm package settings, add a GitHub Actions trusted publisher with
   organization/user `micthiesen`, repository `homebridge-elgato-key-lights`, and
   workflow filename `publish.yml`. Leave the environment name blank because this
   workflow does not use a GitHub environment. Enable direct `npm publish` for
   this publisher; stage-only publishing is not used here.
3. Re-run the publishing workflow after setup. A bootstrapped version is skipped;
   the next version bump exercises trusted publishing.

The workflow requests an OIDC identity and uses `npm publish` directly. It does
not require an `NPM_TOKEN` repository secret. Never commit npm credentials.

## Project Structure

```
src/
├── index.ts                         # Entry point
├── types/                           # TypeScript interfaces
├── config/                          # Constants and settings
├── platform/                        # Platform and device catalog
├── accessories/                     # HomeKit accessory handlers
└── devices/                         # Device API clients
```

## License

[MIT](LICENSE)

## Credits

Forked from [MP Consulting’s plugin](https://github.com/mp-consulting/homebridge-elgato-key-lights), originally forked from [homebridge-keylights](https://github.com/derjayjay/homebridge-keylights) by derjayjay.
