import { afterEach, describe, expect, test } from "bun:test";
import { assertWebAuth } from "./auth.ts";

const AUTH_ENV = [
  "SOLARD_WEB_TOKEN",
  "SOLWAL_WEB_TOKEN",
  "SLRD_WEB_TOKEN",
  "SOLARD_ALLOW_OPEN_WEB",
] as const;

function clearAuthEnv(): void {
  for (const key of AUTH_ENV) delete process.env[key];
}

function requestWithToken(token?: string, header = "x-solwal-web-token"): Request {
  const headers = token ? { [header]: token } : undefined;
  return new Request("http://localhost/api/health", { headers });
}

afterEach(() => {
  clearAuthEnv();
});

describe("assertWebAuth", () => {
  test("fails closed when no token is configured", () => {
    clearAuthEnv();
    expect(() => assertWebAuth(requestWithToken())).toThrow(/not configured/);
    try {
      assertWebAuth(requestWithToken());
    } catch (error) {
      expect((error as { status?: number }).status).toBe(503);
    }
  });

  test("allows open web only with explicit opt-in", () => {
    clearAuthEnv();
    process.env.SOLARD_ALLOW_OPEN_WEB = "1";
    expect(() => assertWebAuth(requestWithToken())).not.toThrow();
  });

  test("accepts a matching x-solwal-web-token", () => {
    clearAuthEnv();
    process.env.SOLWAL_WEB_TOKEN = "secret-token";
    expect(() => assertWebAuth(requestWithToken("secret-token"))).not.toThrow();
  });

  test("accepts SOLARD_WEB_TOKEN and x-solard-web-token header", () => {
    clearAuthEnv();
    process.env.SOLARD_WEB_TOKEN = "canonical-token";
    expect(() =>
      assertWebAuth(requestWithToken("canonical-token", "x-solard-web-token")),
    ).not.toThrow();
  });

  test("accepts Bearer authorization", () => {
    clearAuthEnv();
    process.env.SOLARD_WEB_TOKEN = "bearer-secret";
    const request = new Request("http://localhost/api/health", {
      headers: { authorization: "Bearer bearer-secret" },
    });
    expect(() => assertWebAuth(request)).not.toThrow();
  });

  test("rejects a wrong token with 401", () => {
    clearAuthEnv();
    process.env.SOLARD_WEB_TOKEN = "expected";
    try {
      assertWebAuth(requestWithToken("wrong"));
      throw new Error("expected throw");
    } catch (error) {
      expect((error as Error).message).toBe("Unauthorized");
      expect((error as { status?: number }).status).toBe(401);
    }
  });
});
