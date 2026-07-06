import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * src/config/env.ts reads process.env exactly once, at import time.
 * To test the "fully configured" branch of isGroqConfigured /
 * isNotionConfigured / isWhatsAppConfigured without that stale-import
 * problem, this file mutates process.env for specific keys, forces a
 * fresh module evaluation with vi.resetModules(), then restores the
 * original values afterward so it can't leak state into other test
 * files that import env.ts normally (relying on tests/setupEnv.ts's
 * defaults).
 */
describe("optional integration configuration flags (all configured)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("reports Groq as configured once GROQ_API_KEY is set", async () => {
    process.env.GROQ_API_KEY = "fake-groq-key-for-this-test-only";
    const { isGroqConfigured } = await import("../../src/config/env.js");
    expect(isGroqConfigured).toBe(true);
  });

  it("reports WhatsApp as configured only once ALL four secrets are set", async () => {
    process.env.WHATSAPP_APP_SECRET = "a";
    process.env.WHATSAPP_ACCESS_TOKEN = "b";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "c";
    // Deliberately leave WHATSAPP_VERIFY_TOKEN unset -- this proves the
    // flag requires every one of the four values, not just some of them.
    const { isWhatsAppConfigured: partiallyConfigured } = await import("../../src/config/env.js");
    expect(partiallyConfigured).toBe(false);

    vi.resetModules();
    process.env.WHATSAPP_VERIFY_TOKEN = "d";
    const { isWhatsAppConfigured: fullyConfigured } = await import("../../src/config/env.js");
    expect(fullyConfigured).toBe(true);
  });

  it("reports Notion as configured once client id, secret, and encryption key are all set", async () => {
    process.env.NOTION_OAUTH_CLIENT_ID = "fake-client-id";
    process.env.NOTION_OAUTH_CLIENT_SECRET = "fake-client-secret";
    process.env.NOTION_TOKEN_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".slice(0, 64);
    const { isNotionConfigured } = await import("../../src/config/env.js");
    expect(isNotionConfigured).toBe(true);
  });

  it("reports semantic search as configured once JINA_API_KEY is set", async () => {
    process.env.JINA_API_KEY = "fake-jina-key-for-this-test-only";
    const { isSemanticSearchConfigured } = await import("../../src/config/env.js");
    expect(isSemanticSearchConfigured).toBe(true);
  });

  it("fails fast (throws/exits) if NOTION_TOKEN_ENCRYPTION_KEY is set but malformed", async () => {
    process.env.NOTION_TOKEN_ENCRYPTION_KEY = "not-valid-hex-and-wrong-length";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(import("../../src/config/env.js")).rejects.toThrow("process.exit(1)");

    exitSpy.mockRestore();
  });
});
