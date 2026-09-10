# Configuration

`validation.ts` decodes configuration with Effect Schema, normalizes MAC addresses,
checks device identities and endpoints, and computes explicit settings overrides.
A device requires a MAC or serial number; an address enables operation without mDNS.

Defaults: polling delay 5000 ms, per-request timeout 3000 ms, maximum retry delay
60000 ms. Omitted power-on and transition settings preserve confirmed device settings.
Configuration temperature is Kelvin; HTTP settings use mirek.

Keep `config.schema.json`, runtime validation, and README ranges/defaults aligned.
`settings.ts` owns the published package name and stable platform identifier.
