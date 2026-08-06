import { fork } from "node:child_process";
import { roles } from "./runtime.mjs";
const children = roles.map((role) => fork(new URL("./evidence-gateway.mjs", import.meta.url), [role], { stdio: ["ignore", "inherit", "inherit", "ipc"] }));
children.push(fork(new URL("./network-proxy.mjs", import.meta.url), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] }));
let ready = 0;
for (const child of children) child.on("message", (message) => { if (message?.type === "ready" && ++ready === children.length) process.send?.({ type: "ready", services: ready }); });
const stop = () => { for (const child of children) child.kill("SIGTERM"); setTimeout(() => process.exit(0), 200).unref(); };
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
