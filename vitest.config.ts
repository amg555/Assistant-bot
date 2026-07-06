import { defineConfig } from "vitest/config";

/**
 * Scope note: this suite covers PURE LOGIC ONLY — timezone math,
 * parsing, recurrence calculation, encryption, in-memory stores, Zod
 * schema validation. Anything that talks to Supabase, Telegram,
 * Discord, WhatsApp, Groq, or Notion is deliberately NOT covered here,
 * because doing so would require either real credentials (which must
 * never live in a test suite/CI) or a mocking layer elaborate enough to
 * risk testing the mocks instead of the real integration. See
 * docs/testing.md for the full honest scope of what this suite does
 * and does not prove, and what manual/staging verification still needs
 * to happen before trusting a live deploy.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/validation/**"],
    },
  },
});
