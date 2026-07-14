import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";

const execute = promisify(execFile);
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(appDirectory, "resources");
const source = path.join(resources, "icon.svg");
const iconset = path.join(resources, "icon.iconset");

const images = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });

await Promise.all(
  images.map(([filename, size]) =>
    sharp(source).resize(size, size).png().toFile(path.join(iconset, filename)),
  ),
);

await sharp(source).resize(1024, 1024).png().toFile(path.join(resources, "icon.png"));
await execute("iconutil", [
  "--convert",
  "icns",
  iconset,
  "--output",
  path.join(resources, "icon.icns"),
]);
await rm(iconset, { recursive: true, force: true });

console.log("Created resources/icon.png and resources/icon.icns");
