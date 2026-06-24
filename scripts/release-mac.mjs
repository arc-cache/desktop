#!/usr/bin/env node
import {
  assessGatekeeperApp,
  assessGatekeeperDiskImage,
  buildMacApp,
  describeNotarizationCredentials,
  ensureDarwin,
  findArtifactsByExtension,
  findNewestAppBundle,
  hasNotarizationCredentials,
  loadLocalSigningEnv,
  notarizeStapleAndValidate,
  relative,
  releaseDir,
  resolveDeveloperIdIdentity,
  signDiskImage,
  stapleAndValidate,
  verifyArcPackage,
  verifySignedApp,
} from "./mac-signing-utils.mjs";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const skipBuild = args.has("--skip-build");

ensureDarwin("npm run app:release:mac");
loadLocalSigningEnv();

const identity = resolveDeveloperIdIdentity();
console.log(`Using signing identity: ${identity.hash} (${identity.name})`);

if (!hasNotarizationCredentials()) {
  throw new Error(
    [
      "A macOS release build must be notarized.",
      "Configure either APPLE_NOTARY_KEYCHAIN_PROFILE or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.",
      "",
      "Recommended one-time setup:",
      "  xcrun notarytool store-credentials arc-notary --apple-id you@example.com --team-id TEAMID --password APP-SPECIFIC-PASSWORD",
      "",
      "Then put this in the ignored .env.signing.local file:",
      "  APPLE_NOTARY_KEYCHAIN_PROFILE=arc-notary",
    ].join("\n")
  );
}

console.log(`Using notarization credentials: ${describeNotarizationCredentials()}`);

if (skipBuild) {
  console.log("Skipping build; using existing apps/arc-app/release output.");
} else {
  buildMacApp({ identity, release: true });
}

verifyArcPackage();

const appBundle = findNewestAppBundle();
if (!appBundle) {
  throw new Error("No built ARC.app bundle found under apps/arc-app/release.");
}

console.log(`Verifying signed app: ${relative(appBundle)}`);
verifySignedApp(appBundle);

console.log("Verifying notarization ticket on app bundle.");
stapleAndValidate(appBundle);
assessGatekeeperApp(appBundle);

const dmgs = findArtifactsByExtension(releaseDir, [".dmg"]);
for (const dmg of dmgs) {
  console.log(`Verifying notarized disk image: ${relative(dmg)}`);
  signDiskImage(dmg, identity);
  notarizeStapleAndValidate(dmg);
  assessGatekeeperDiskImage(dmg);
}

const artifacts = findArtifactsByExtension(releaseDir, [".dmg", ".zip"]);
console.log("Release artifacts:");
for (const artifact of artifacts) {
  console.log(`  ${relative(artifact)}`);
}

function printHelp() {
  console.log(`Usage: npm run app:release:mac -- [options]

Build, Developer ID sign, notarize, staple, and verify macOS release artifacts.

Options:
  --skip-build   Reuse the existing apps/arc-app/release output and only verify/staple.

Signing:
  ARC_MAC_SIGN_IDENTITY must point at a Developer ID Application hash.

Notarization:
  Recommended: store Apple credentials in the keychain, then reference the profile:
    xcrun notarytool store-credentials arc-notary --apple-id you@example.com --team-id TEAMID --password APP-SPECIFIC-PASSWORD

  .env.signing.local:
    ARC_MAC_SIGN_IDENTITY=0123456789ABCDEF0123456789ABCDEF01234567
    APPLE_NOTARY_KEYCHAIN_PROFILE=arc-notary
`);
}
