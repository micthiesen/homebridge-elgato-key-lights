# Platform

`KeyLightsPlatform.ts` owns the Homebridge lifecycle, scoped mDNS discovery and device
supervisors, and accessory identity reconciliation. Configuration and cached
accessories can start recovery without discovery. Keep one active session per light
and preserve existing serial-derived HomeKit UUIDs when addresses change.

Acquire discovery resources in a scope, keep device work in child scopes, and interrupt
all work during shutdown. Discovery events provide address candidates; successful
HTTP communication determines availability.
