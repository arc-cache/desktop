import assert from "node:assert/strict";
import test from "node:test";

import {
  hasNotarizationCredentials,
  redactSensitiveText,
  run,
  withoutSensitiveSigningEnv,
} from "../scripts/mac-signing-utils.mjs";

function withEnv(values, fn) {
  return async () => {
    const previous = new Map();
    for (const key of Object.keys(values)) {
      previous.set(key, process.env[key]);
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    try {
      await fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

test("mac signing helpers accept keychain profiles or Apple ID credentials for notarization", withEnv({
  APPLE_ID: "person@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "app-specific-secret",
  APPLE_TEAM_ID: "TEAMSECRET",
  APPLE_NOTARY_KEYCHAIN_PROFILE: undefined,
  APPLE_KEYCHAIN_PROFILE: undefined,
}, () => {
  assert.equal(hasNotarizationCredentials(), true);

  delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
  assert.equal(hasNotarizationCredentials(), false);

  process.env.APPLE_NOTARY_KEYCHAIN_PROFILE = "arc-notary";
  assert.equal(hasNotarizationCredentials(), true);
}));

test("mac signing helpers remove notarization secrets from ordinary build environments", withEnv({
  APPLE_ID: "person@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "app-specific-secret",
  APPLE_TEAM_ID: "TEAMSECRET",
  CSC_LINK: "base64-cert-secret",
  CSC_KEY_PASSWORD: "cert-password",
}, () => {
  const clean = withoutSensitiveSigningEnv(process.env);

  assert.equal(clean.APPLE_ID, undefined);
  assert.equal(clean.APPLE_APP_SPECIFIC_PASSWORD, undefined);
  assert.equal(clean.APPLE_TEAM_ID, undefined);
  assert.equal(clean.CSC_LINK, undefined);
  assert.equal(clean.CSC_KEY_PASSWORD, undefined);
}));

test("mac signing command failures redact sensitive arguments and captured output", withEnv({
  APPLE_ID: "person@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "app-specific-secret",
  APPLE_TEAM_ID: "TEAMSECRET",
}, () => {
  const text = [
    "--apple-id person@example.com --password app-specific-secret --team-id TEAMSECRET",
    "APPLE_APP_SPECIFIC_PASSWORD=app-specific-secret",
  ].join("\n");
  assert.equal(redactSensitiveText(text).includes("person@example.com"), false);
  assert.equal(redactSensitiveText(text).includes("app-specific-secret"), false);
  assert.equal(redactSensitiveText(text).includes("TEAMSECRET"), false);

  assert.throws(
    () => run(process.execPath, [
      "-e",
      "console.error('APPLE_ID=person@example.com password=app-specific-secret team TEAMSECRET'); process.exit(7);",
    ], {
      quiet: true,
    }),
    (error) => {
      assert.equal(error.message.includes("person@example.com"), false);
      assert.equal(error.message.includes("app-specific-secret"), false);
      assert.equal(error.message.includes("TEAMSECRET"), false);
      assert.match(error.message, /<redacted>/);
      return true;
    }
  );
}));
