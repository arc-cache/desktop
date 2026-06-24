#!/usr/bin/env node
import { rmSync } from "node:fs";
import {
  buildMacApp,
  ensureDarwin,
  findNewestAppBundle,
  installedAppPath,
  loadLocalSigningEnv,
  quitInstalledArc,
  relative,
  resolveDeveloperIdIdentity,
  run,
  verifyArcPackage,
  verifySignedApp,
} from "./mac-signing-utils.mjs";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const skipBuild = args.has("--skip-build");
const noInstall = args.has("--no-install");
const noOpen = args.has("--no-open") || noInstall || process.env.ARC_NO_OPEN === "1";

ensureDarwin("npm run app:install:signed");
loadLocalSigningEnv();

const identity = resolveDeveloperIdIdentity();
console.log(`Using signing identity: ${identity.hash} (${identity.name})`);

if (skipBuild) {
  console.log("Skipping build; using existing apps/arc-app/release output.");
} else {
  buildMacApp({ identity, release: false });
}

verifyArcPackage();

const appBundle = findNewestAppBundle();
if (!appBundle) {
  throw new Error("No built ARC.app bundle found under apps/arc-app/release.");
}

console.log(`Verifying signed app: ${relative(appBundle)}`);
verifySignedApp(appBundle);

if (noInstall) {
  console.log(`Signed app is ready at ${relative(appBundle)}`);
  process.exit(0);
}

console.log(`Installing ${relative(appBundle)} -> ${installedAppPath}`);
quitInstalledArc();
rmSync(installedAppPath, { recursive: true, force: true });
run("ditto", [appBundle, installedAppPath]);

console.log("Verifying installed app signature.");
verifySignedApp(installedAppPath);

const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", installedAppPath], {
  allowFailure: true,
  quiet: true,
});
if (gatekeeper.status === 0) {
  console.log("Gatekeeper accepted the installed app.");
} else {
  console.log("Gatekeeper did not accept the installed app yet. That is expected for local signed builds before notarization.");
}

if (!noOpen) {
  run("open", [installedAppPath]);
}

console.log(`Installed signed ARC app at ${installedAppPath}`);

function printHelp() {
  console.log(`Usage: npm run app:install:signed -- [options]

Build, Developer ID sign, verify, install, and open ARC.app locally.

Options:
  --skip-build   Reuse the existing apps/arc-app/release output.
  --no-install   Build and verify only; do not copy to /Applications.
  --no-open      Install but do not open the app.

Signing:
  Set ARC_MAC_SIGN_IDENTITY to a Developer ID Application hash in .env.signing.local.
  The file is ignored by git. Example:
    ARC_MAC_SIGN_IDENTITY=0123456789ABCDEF0123456789ABCDEF01234567
`);
}
