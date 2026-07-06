import { describe, it, expect } from "vitest";
import { isWhatsAppConfigured, isGroqConfigured, isNotionConfigured, isSemanticSearchConfigured } from "../../src/config/env.js";

/**
 * tests/setupEnv.ts deliberately leaves WHATSAPP_*, GROQ_API_KEY, and
 * all NOTION_OAUTH_* / NOTION_WEBHOOK_SECRET values blank -- mirroring
 * a real deployment that hasn't configured those optional integrations.
 * These assertions confirm the fail-closed gates actually reflect that:
 * an unconfigured integration must report itself as unconfigured, not
 * accidentally appear "on" due to a falsy-but-truthy string bug (e.g.
 * an empty-but-non-empty placeholder value).
 */
describe("optional integration configuration flags", () => {
  it("reports WhatsApp as not configured when its secrets are blank", () => {
    expect(isWhatsAppConfigured).toBe(false);
  });

  it("reports Groq as not configured when GROQ_API_KEY is blank", () => {
    expect(isGroqConfigured).toBe(false);
  });

  it("reports Notion as not configured when its OAuth credentials are blank", () => {
    expect(isNotionConfigured).toBe(false);
  });

  it("reports semantic search as not configured when JINA_API_KEY is blank", () => {
    expect(isSemanticSearchConfigured).toBe(false);
  });
});
