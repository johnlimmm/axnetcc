import { copyFile, readdir } from "node:fs/promises";

const clientDirectory = new URL("../dist/client/", import.meta.url);
const publicDirectory = new URL("../public/", import.meta.url);
for (const entry of await readdir(clientDirectory, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
    await copyFile(
      new URL(entry.name, clientDirectory),
      new URL(entry.name, publicDirectory),
    );
  }
}
