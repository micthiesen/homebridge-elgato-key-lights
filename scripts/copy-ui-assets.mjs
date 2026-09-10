import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const destination = new URL("homebridge-ui/public/lib/", root);
await mkdir(new URL("fonts/", destination), { recursive: true });
const assets = {
  "@mp-consulting/homebridge-ui-kit/dist/kit.css": "kit.css",
  "@mp-consulting/homebridge-ui-kit/dist/kit.js": "kit.js",
  "bootstrap/dist/css/bootstrap.min.css": "bootstrap.min.css",
  "bootstrap/dist/js/bootstrap.bundle.min.js": "bootstrap.bundle.min.js",
  "bootstrap-icons/font/bootstrap-icons.min.css": "bootstrap-icons.min.css",
  "bootstrap-icons/font/fonts/bootstrap-icons.woff": "fonts/bootstrap-icons.woff",
  "bootstrap-icons/font/fonts/bootstrap-icons.woff2": "fonts/bootstrap-icons.woff2",
};
for (const [source, target] of Object.entries(assets)) {
  await copyFile(new URL(`node_modules/${source}`, root), new URL(target, destination));
}
for (const file of ["bootstrap.min.css", "bootstrap.bundle.min.js"]) {
  const path = new URL(file, destination);
  const contents = await readFile(path, "utf8");
  await writeFile(path, contents.replace(/^\s*\/[*/]# sourceMappingURL=.*$/gm, ""));
}
