import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishDirectory = path.join(projectDirectory, "dist");

await mkdir(publishDirectory, { recursive: true });
await cp(path.join(projectDirectory, "index.html"), path.join(publishDirectory, "index.html"), { force: true });
await cp(path.join(projectDirectory, "assets"), path.join(publishDirectory, "assets"), {
  recursive: true,
  force: true
});

console.log("Never Go Alone V3: static files ready for Netlify.");
