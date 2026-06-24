#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "arc-app");
const sourceSvg = join(appDir, "build", "icon.svg");
const sourcePng = join(appDir, "public", "icon.png");
const buildDir = join(appDir, "build");
const buildPng = join(buildDir, "icon.png");
const buildIcns = join(buildDir, "icon.icns");

const icnsEntries = [
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
main();

function main() {
  ensureTool("sips");
  ensureTool("iconutil");
  mkdirSync(buildDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "arc-icons-"));
  try {
    const masterPng = resolveMasterPng(workDir);
    copyFileSync(masterPng, sourcePng);
    copyFileSync(masterPng, buildPng);
    generateIcns(workDir, masterPng);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`Generated ${relative(sourcePng)}`);
  console.log(`Generated ${relative(buildPng)}`);
  console.log(`Generated ${relative(buildIcns)}`);
}

function resolveMasterPng(workDir) {
  if (existsSync(sourceSvg)) {
    ensureTool("qlmanage");
    run("qlmanage", ["-t", "-s", "1024", "-o", workDir, sourceSvg], { quiet: true });
    const rendered = join(workDir, "icon.svg.png");
    if (!existsSync(rendered)) {
      throw new Error(`qlmanage did not render ${relative(sourceSvg)} to ${rendered}`);
    }
    return rendered;
  }

  if (existsSync(sourcePng)) return sourcePng;
  throw new Error(`Missing source icon: expected ${relative(sourceSvg)} or ${relative(sourcePng)}`);
}

function generateIcns(workDir, masterPng) {
  const iconsetDir = join(workDir, "ARC.iconset");
  mkdirSync(iconsetDir, { recursive: true });

  for (const [name, size] of icnsEntries) {
    resizePng(masterPng, join(iconsetDir, name), size);
  }

  run("iconutil", ["-c", "icns", iconsetDir, "-o", buildIcns]);
}

function resizePng(input, output, size) {
  run("sips", ["-z", String(size), String(size), input, "--out", output], { quiet: true });
}

function ensureTool(command) {
  const result = spawnSync("which", [command], {
    cwd: root,
    stdio: "ignore",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} is required to generate app icons.`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${output ? `\n${output}` : ""}`);
  }
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
