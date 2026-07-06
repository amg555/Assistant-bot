import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../src/lib/tokenCrypto.js";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value exactly", () => {
    const original = "secret_notionAccessTokenAbc123";
    const encrypted = encryptSecret(original);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces ciphertext that does not equal the plaintext", () => {
    const original = "another-secret-value";
    const encrypted = encryptSecret(original);
    expect(encrypted.ciphertext).not.toBe(original);
  });

  it("produces different ciphertext for the same plaintext on repeated calls (random IV)", () => {
    const original = "same-input-both-times";
    const first = encryptSecret(original);
    const second = encryptSecret(original);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
    // Both must still decrypt to the same original value.
    expect(decryptSecret(first)).toBe(original);
    expect(decryptSecret(second)).toBe(original);
  });

  it("rejects a tampered ciphertext instead of silently returning garbage", () => {
    const encrypted = encryptSecret("integrity-protected-value");
    const tampered = {
      ...encrypted,
      ciphertext: (encrypted.ciphertext[0] === "0" ? "1" : "0") + encrypted.ciphertext.slice(1),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const encrypted = encryptSecret("another-integrity-protected-value");
    const tampered = {
      ...encrypted,
      authTag: (encrypted.authTag[0] === "0" ? "1" : "0") + encrypted.authTag.slice(1),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("handles empty string plaintext", () => {
    const encrypted = encryptSecret("");
    expect(decryptSecret(encrypted)).toBe("");
  });

  it("handles unicode content correctly", () => {
    const original = "Notion workspace: 日本語 émojis 🔒";
    const encrypted = encryptSecret(original);
    expect(decryptSecret(encrypted)).toBe(original);
  });
});
