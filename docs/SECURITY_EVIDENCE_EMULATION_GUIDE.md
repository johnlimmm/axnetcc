# Security evidence emulation guide

Start the fixed HTTP endpoints with:

```bash
pnpm evidence:emulation
```

Eight owner gateways listen on `127.0.0.1:4311` through `4318`; the proxy listens on `127.0.0.1:4400`. The proxy injects seeded application-layer latency, jitter, bandwidth delay, synthetic 503/loss, timeouts, and owner-processing multipliers from `emulation/scenarios.json`.

This is application-layer emulation. Reported request/response sizes are UTF-8 application payload bytes, not packet or wire bytes. Timings include real localhost HTTP and host scheduling plus injected delay.
