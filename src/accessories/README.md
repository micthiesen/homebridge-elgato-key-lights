# HomeKit accessories

`KeyLightsAccessory.ts` adapts HomeKit callbacks to the platform's Effect runtime and
renders confirmed device snapshots. Offline reads and failed writes must report a
communication error instead of presenting stale values as a successful response.

Keep existing accessory UUIDs and characteristics across reconnects. Clamp device
mirek temperatures at the HomeKit boundary. Callback registration must not multiply
when discovery repeats, and stopped sessions must not update characteristics.
