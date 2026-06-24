import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const appDir = join(root, "apps", "arc-app");
export const releaseDir = join(appDir, "release");
export const installedAppPath = "/Applications/ARC.app";

const developerIdPrefix = "Developer ID Application:";
const identityPattern = /^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"]+)"/;
const sensitiveEnvironmentKeys = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "ASC_PRIVATE_KEY",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
];

export function ensureDarwin(commandName) {
  if (process.platform !== "darwin") {
    throw new Error(`${commandName} must run on macOS because Apple codesigning tools are required.`);
  }
}

export function loadLocalSigningEnv() {
  const files = [
    join(root, ".env"),
    join(appDir, ".env"),
    join(root, ".env.signing.local"),
    join(appDir, ".env.signing.local"),
  ];
  const loaded = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    loadEnvFile(file);
    loaded.push(relative(file));
  }
  if (loaded.length) {
    console.log(`Loaded local signing env: ${loaded.join(", ")}`);
  }
}

export function resolveDeveloperIdIdentity() {
  const identities = listCodeSigningIdentities();
  const explicit = process.env.ARC_MAC_SIGN_IDENTITY || process.env.CSC_NAME || "";

  if (explicit.trim()) {
    return resolveExplicitIdentity(explicit.trim(), identities);
  }

  const developerIds = identities.filter((identity) => identity.name.startsWith(developerIdPrefix));
  const uniqueByHash = uniqueIdentitiesByHash(developerIds);
  if (!uniqueByHash.length) {
    throw new Error(
      [
        "No valid Developer ID Application identity was found.",
        "Install the Developer ID Application certificate and its private key, then run:",
        "  security find-identity -v -p codesigning",
      ].join("\n")
    );
  }

  if (uniqueByHash.length === 1) {
    return uniqueByHash[0];
  }

  throw new Error(
    [
      "Multiple Developer ID Application identities are installed.",
      "Set ARC_MAC_SIGN_IDENTITY to the 40-character hash you want ARC builds to use.",
      "",
      formatIdentities(uniqueByHash),
      "",
      "Example:",
      `  ARC_MAC_SIGN_IDENTITY=${uniqueByHash[0].hash} npm run app:install:signed`,
      "",
      "For day-to-day use, put the hash in the ignored .env.signing.local file.",
    ].join("\n")
  );
}

export function buildSigningEnv(identity, extra = {}) {
  return {
    ...process.env,
    ...extra,
    CSC_NAME: identity.hash,
  };
}

export function buildMacApp({ identity, release = false }) {
  rmSync(releaseDir, { recursive: true, force: true });
  const publicBuildEnv = withoutSensitiveSigningEnv(process.env);
  run("npm", ["run", "app:icons"], { env: publicBuildEnv });
  run("npm", ["run", "build"], { env: publicBuildEnv });
  run("pnpm", ["--dir", appDir, "build"], { env: publicBuildEnv });

  const targetArgs = release ? ["--mac", "dmg", "zip"] : ["--mac", "dir"];
  run(
    "pnpm",
    ["--dir", appDir, "exec", "electron-builder", ...targetArgs, "--config", "electron-builder.config.js"],
    {
      env: buildSigningEnv(identity, release ? {} : { ARC_SKIP_NOTARIZE: "1" }),
    }
  );
}

export function verifyArcPackage() {
  run("node", [join(root, "scripts", "verify-arc-app-package.mjs")]);
}

export function verifySignedApp(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("codesign", ["-dv", "--verbose=4", appPath]);
}

export function signDiskImage(dmgPath, identity) {
  console.log(`Signing disk image: ${relative(dmgPath)}`);
  run("codesign", ["--force", "--sign", identity.hash, "--timestamp", dmgPath]);
  run("codesign", ["--verify", "--verbose=4", dmgPath]);
}

export function assessGatekeeperApp(appPath) {
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
}

export function assessGatekeeperDiskImage(dmgPath) {
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);
}

export function stapleAndValidate(path) {
  const validation = run("xcrun", ["stapler", "validate", path], {
    allowFailure: true,
    quiet: true,
  });
  if (validation.status === 0) {
    console.log(`Staple valid: ${relative(path)}`);
    return;
  }

  run("xcrun", ["stapler", "staple", path]);
  run("xcrun", ["stapler", "validate", path]);
}

export function notarizeStapleAndValidate(path) {
  const validation = run("xcrun", ["stapler", "validate", path], {
    allowFailure: true,
    quiet: true,
  });
  if (validation.status === 0) {
    console.log(`Staple valid: ${relative(path)}`);
    return;
  }

  notarizeArtifact(path);
  run("xcrun", ["stapler", "staple", path]);
  run("xcrun", ["stapler", "validate", path]);
}

export function notarizeArtifact(path) {
  const credentials = notarizationCredentialSets();
  if (!credentials.length) {
    throw new Error("No Apple notarization credentials are configured.");
  }

  let lastFailure = null;
  for (const credential of credentials) {
    const args = [
      "notarytool",
      "submit",
      path,
      ...credential.args,
      "--wait",
      "--output-format",
      "json",
    ];
    const displayArgs = [
      "notarytool",
      "submit",
      relative(path),
      ...credential.displayArgs,
      "--wait",
      "--output-format",
      "json",
    ];

    console.log(`Notarizing ${relative(path)} with ${credential.label}...`);
    const result = run("xcrun", args, {
      allowFailure: true,
      displayArgs,
      quiet: true,
    });
    if (result.status === 0) {
      console.log(`Notarization complete: ${relative(path)}`);
      return;
    }

    lastFailure = { result, displayArgs };
    if (credentials.length > 1 && credential !== credentials.at(-1)) {
      console.log(`Notarization failed with ${credential.label}; trying next configured credential set.`);
    }
  }

  const output = lastFailure ? formatCapturedOutput(lastFailure.result) : "";
  const displayedCommand = lastFailure
    ? redactSensitiveText(`xcrun ${lastFailure.displayArgs.join(" ")}`)
    : "xcrun notarytool submit";
  throw new Error(`${displayedCommand} failed${output}`);
}

export function quitInstalledArc() {
  run("osascript", ["-e", 'tell application "ARC" to quit'], {
    allowFailure: true,
    quiet: true,
  });
}

export function findNewestAppBundle(dir = releaseDir) {
  return newestPath(findAppBundles(dir));
}

export function findArtifactsByExtension(dir, extensions) {
  return findFiles(dir, (path, entry) => entry.isFile() && extensions.some((ext) => path.endsWith(ext)))
    .sort((a, b) => a.localeCompare(b));
}

export function hasNotarizationCredentials() {
  return notarizationCredentialSets().length > 0;
}

export function describeNotarizationCredentials() {
  const credentials = notarizationCredentialSets();
  return credentials.length ? credentials.map((credential) => credential.label).join(", ") : "none";
}

export function run(command, args, options = {}) {
  const {
    cwd = root,
    env = process.env,
    allowFailure = false,
    quiet = false,
    displayArgs = args,
  } = options;

  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const output = quiet ? formatCapturedOutput(result) : "";
    const displayedCommand = redactSensitiveText(`${command} ${displayArgs.join(" ")}`);
    throw new Error(`${displayedCommand} failed with exit ${result.status}${output}`);
  }
  return result;
}

export function withoutSensitiveSigningEnv(env) {
  const clean = { ...env };
  for (const key of sensitiveEnvironmentKeys) {
    delete clean[key];
  }
  return clean;
}

export function redactSensitiveText(value) {
  let redacted = String(value);
  for (const secret of sensitiveEnvironmentValues()) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted
    .replace(/(--(?:apple-id|password|team-id)\s+)(?:"[^"]+"|'[^']+'|\S+)/gi, "$1<redacted>")
    .replace(/\b((?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|APPLE_API_KEY|APPLE_API_KEY_ID|APPLE_API_ISSUER|ASC_KEY_ID|ASC_ISSUER_ID|ASC_PRIVATE_KEY|CSC_LINK|CSC_KEY_PASSWORD|CSC_INSTALLER_LINK|CSC_INSTALLER_KEY_PASSWORD)=)(?:"[^"]+"|'[^']+'|\S+)/g, "$1<redacted>");
}

export function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function listCodeSigningIdentities() {
  const result = run("security", ["find-identity", "-v", "-p", "codesigning"], {
    allowFailure: true,
    quiet: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = identityPattern.exec(line);
      if (!match) return null;
      return { hash: match[1], name: match[2] };
    })
    .filter(Boolean);
}

function resolveExplicitIdentity(value, identities) {
  const normalized = value.toUpperCase();
  const developerIds = identities.filter((identity) => identity.name.startsWith(developerIdPrefix));

  if (/^[A-F0-9]{40}$/.test(normalized)) {
    const found = developerIds.find((identity) => identity.hash === normalized);
    if (!found) {
      throw new Error(
        [
          `ARC_MAC_SIGN_IDENTITY is set to ${normalized}, but that valid Developer ID Application identity was not found.`,
          "Run security find-identity -v -p codesigning and update .env.signing.local.",
        ].join("\n")
      );
    }
    return found;
  }

  const matchingNames = uniqueIdentitiesByHash(developerIds.filter((identity) => identity.name === value));
  if (matchingNames.length === 1) {
    return matchingNames[0];
  }
  if (matchingNames.length > 1) {
    throw new Error(
      [
        `The signing identity name "${value}" is ambiguous.`,
        "Use one of these hashes instead:",
        "",
        formatIdentities(matchingNames),
      ].join("\n")
    );
  }

  throw new Error(
    [
      `ARC_MAC_SIGN_IDENTITY/CSC_NAME does not name a valid Developer ID Application identity: ${value}`,
      "Use a 40-character Developer ID Application hash from:",
      "  security find-identity -v -p codesigning",
    ].join("\n")
  );
}

function uniqueIdentitiesByHash(identities) {
  const byHash = new Map();
  for (const identity of identities) {
    if (!byHash.has(identity.hash)) byHash.set(identity.hash, identity);
  }
  return [...byHash.values()];
}

function formatIdentities(identities) {
  return identities.map((identity) => `  ${identity.hash}  ${identity.name}`).join("\n");
}

function notarizationCredentialSets() {
  const credentials = [];
  const profile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE || process.env.APPLE_KEYCHAIN_PROFILE;
  if (profile) {
    credentials.push({
      label: `keychain profile "${profile}"`,
      args: ["--keychain-profile", profile],
      displayArgs: ["--keychain-profile", profile],
    });
  }

  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (appleId && password && teamId) {
    credentials.push({
      label: "Apple ID credentials",
      args: ["--apple-id", appleId, "--password", password, "--team-id", teamId],
      displayArgs: ["--apple-id", "<redacted>", "--password", "<redacted>", "--team-id", "<redacted>"],
    });
  }

  return credentials;
}

function loadEnvFile(file) {
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;

    const [, key, rawValue] = assignment;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

function findAppBundles(dir) {
  return findFiles(dir, (path, entry) => entry.isDirectory() && entry.name.endsWith(".app"), {
    descendIntoMatches: false,
  });
}

function findFiles(dir, predicate, options = {}) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const matches = predicate(path, entry);
    if (matches) result.push(path);
    if (entry.isDirectory() && (!matches || options.descendIntoMatches !== false)) {
      result.push(...findFiles(path, predicate, options));
    }
  }
  return result;
}

function newestPath(paths) {
  return paths
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
}

function formatCapturedOutput(result) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return output ? `\n${redactSensitiveText(output)}` : "";
}

function sensitiveEnvironmentValues() {
  return sensitiveEnvironmentKeys
    .map((key) => process.env[key])
    .filter((value) => typeof value === "string" && value.length >= 3)
    .sort((a, b) => b.length - a.length);
}
