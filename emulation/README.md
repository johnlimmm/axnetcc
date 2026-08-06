# Security evidence HTTP emulation

Run `node emulation/emulation-supervisor.mjs` to start eight fixed owner gateways on ports 4311–4318 and the application-layer proxy on port 4400. Gateways expose `GET /health` and `POST /evidence/fetch`; the proxy exposes `GET /health` and `POST /proxy/fetch`.

The proxy injects deterministic seeded latency, jitter, bandwidth delay, synthetic 503/loss, timeout, and owner-processing multipliers. Measurements are application payload bytes and process elapsed time—not packet-level wire bytes or physical KOREN measurements.
