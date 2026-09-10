# Device sessions

`KeyLightInstance.ts` maintains confirmed device state and runs an Effect supervisor.
Polling, initialization, settings, and commands share a per-device semaphore.

Failures mark the device offline and retry indefinitely with capped exponential
backoff and jitter. Rediscovery replaces candidate endpoints and wakes recovery.
Validate identity before controlling a new endpoint, ignore obsolete responses after
address changes, and never report failed writes as applied settings. The platform
owns the supervisor's scope and shutdown.
