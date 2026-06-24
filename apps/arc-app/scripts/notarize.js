// macOS notarization hook for electron-builder
// Requires: pnpm add -D @electron/notarize
// Prefer: APPLE_NOTARY_KEYCHAIN_PROFILE, created with xcrun notarytool store-credentials.
// Fallback: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.

const path = require("path");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  if (process.env.ARC_SKIP_NOTARIZE === "1") {
    console.log("Skipping notarization: ARC_SKIP_NOTARIZE=1");
    return;
  }

  const keychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE || process.env.APPLE_KEYCHAIN_PROFILE;
  const hasAppleIdCredentials = Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  );

  if (!keychainProfile && !hasAppleIdCredentials) {
    console.log("Skipping notarization: no Apple credentials set");
    return;
  }

  const { notarize } = require("@electron/notarize");
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const appBundleId =
    context.packager?.appInfo?.id ||
    context.packager?.config?.appId ||
    "io.github.ayubmoh1.agentruncache";

  const optionSets = [];
  if (keychainProfile) {
    optionSets.push({
      label: `keychain profile "${keychainProfile}"`,
      options: { appBundleId, appPath, keychainProfile },
    });
  }
  if (hasAppleIdCredentials) {
    optionSets.push({
      label: "Apple ID credentials",
      options: {
        appBundleId,
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    });
  }

  let lastError = null;
  for (const { label, options } of optionSets) {
    try {
      console.log(`Notarizing ${appName} (${appBundleId}) with ${label}...`);
      await notarize(options);
      console.log("Notarization complete");
      return;
    } catch (error) {
      lastError = error;
      if (optionSets.at(-1)?.label !== label) {
        console.log(`Notarization failed with ${label}; trying next configured credential set.`);
      }
    }
  }

  throw lastError;
};
