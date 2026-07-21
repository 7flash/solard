import { afterEach, describe, expect, test } from "bun:test";
import {
  allowOpenWebAuth,
  configuredWebToken,
  liveTradesEnabled,
  webAuthConfigured,
} from "./safety.ts";

const LIVE_KEYS = [
  "SOLARD_ENABLE_LIVE_TRADES",
  "SOLWAL_ENABLE_LIVE_TRADES",
  "SLRD_ENABLE_LIVE_TRADES",
] as const;

const TOKEN_KEYS = [
  "SOLARD_WEB_TOKEN",
  "SOLWAL_WEB_TOKEN",
  "SLRD_WEB_TOKEN",
] as const;

const OPEN_WEB_KEYS = ["SOLARD_ALLOW_OPEN_WEB"] as const;

function clearEnv(keys: readonly string[]): void {
  for (const key of keys) delete process.env[key];
}

afterEach(() => {
  clearEnv([...LIVE_KEYS, ...TOKEN_KEYS, ...OPEN_WEB_KEYS]);
});

describe("liveTradesEnabled", () => {
  test("is false when no live flags are set", () => {
    clearEnv(LIVE_KEYS);
    expect(liveTradesEnabled()).toBe(false);
  });

  test("accepts SOLARD_ENABLE_LIVE_TRADES=1", () => {
    clearEnv(LIVE_KEYS);
    process.env.SOLARD_ENABLE_LIVE_TRADES = "1";
    expect(liveTradesEnabled()).toBe(true);
  });

  test("accepts SOLWAL_ENABLE_LIVE_TRADES=1", () => {
    clearEnv(LIVE_KEYS);
    process.env.SOLWAL_ENABLE_LIVE_TRADES = "1";
    expect(liveTradesEnabled()).toBe(true);
  });

  test("accepts SLRD_ENABLE_LIVE_TRADES=1", () => {
    clearEnv(LIVE_KEYS);
    process.env.SLRD_ENABLE_LIVE_TRADES = "1";
    expect(liveTradesEnabled()).toBe(true);
  });

  test("ignores non-1 values", () => {
    clearEnv(LIVE_KEYS);
    process.env.SOLARD_ENABLE_LIVE_TRADES = "true";
    process.env.SOLWAL_ENABLE_LIVE_TRADES = "yes";
    process.env.SLRD_ENABLE_LIVE_TRADES = "0";
    expect(liveTradesEnabled()).toBe(false);
  });
});

describe("configuredWebToken / webAuthConfigured", () => {
  test("prefers SOLARD_WEB_TOKEN over legacy aliases", () => {
    clearEnv(TOKEN_KEYS);
    process.env.SOLWAL_WEB_TOKEN = "legacy";
    process.env.SOLARD_WEB_TOKEN = "canonical";
    expect(configuredWebToken()).toBe("canonical");
    expect(webAuthConfigured()).toBe(true);
  });

  test("falls back to SOLWAL_WEB_TOKEN", () => {
    clearEnv(TOKEN_KEYS);
    process.env.SOLWAL_WEB_TOKEN = "legacy";
    expect(configuredWebToken()).toBe("legacy");
    expect(webAuthConfigured()).toBe(true);
  });

  test("is null when unset", () => {
    clearEnv(TOKEN_KEYS);
    expect(configuredWebToken()).toBeNull();
    expect(webAuthConfigured()).toBe(false);
  });
});

describe("allowOpenWebAuth", () => {
  test("is false by default", () => {
    clearEnv(OPEN_WEB_KEYS);
    expect(allowOpenWebAuth()).toBe(false);
  });

  test("is true when SOLARD_ALLOW_OPEN_WEB=1", () => {
    process.env.SOLARD_ALLOW_OPEN_WEB = "1";
    expect(allowOpenWebAuth()).toBe(true);
  });
});
