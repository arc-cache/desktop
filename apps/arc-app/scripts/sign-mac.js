// electron-builder finds the right Developer ID hash, but its default macOS
// signing bridge passes the display name to codesign. That fails when the same
// certificate exists in multiple keychains. Keep the SHA-1 identity intact.

const { signAsync } = require("@electron/osx-sign");

exports.default = async function signMac(configuration) {
  const identitySource =
    process.env.ARC_MAC_SIGN_IDENTITY ? "ARC_MAC_SIGN_IDENTITY"
      : process.env.CSC_NAME ? "CSC_NAME"
        : configuration.identity ? "electron-builder identity"
          : null;
  const identity = process.env.ARC_MAC_SIGN_IDENTITY || process.env.CSC_NAME || configuration.identity;
  if (!identity) {
    throw new Error("macOS signing requires ARC_MAC_SIGN_IDENTITY, CSC_NAME, or an electron-builder identity.");
  }

  const normalizedIdentity = identity === "-" ? identity : identity.toUpperCase();
  if (normalizedIdentity !== "-" && !/^[A-F0-9]{40}$/.test(normalizedIdentity)) {
    throw new Error(
      [
        "macOS signing identity must be a 40-character Developer ID SHA-1 hash.",
        `Received a non-hash value from ${identitySource}.`,
        "Run security find-identity -v -p codesigning and set ARC_MAC_SIGN_IDENTITY in .env.signing.local.",
      ].join("\n")
    );
  }

  await signAsync({
    ...configuration,
    identity: normalizedIdentity,
    identityValidation: false,
  });
};
