import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../app/globals.css", import.meta.url),
  new URL("../public/site.css", import.meta.url),
);
