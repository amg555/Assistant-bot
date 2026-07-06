import { describe, it, expect } from "vitest";
import { embeddingToPgVectorLiteral } from "../../src/services/jinaClient.js";

describe("embeddingToPgVectorLiteral", () => {
  it("formats a numeric array as a pgvector literal string", () => {
    expect(embeddingToPgVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("handles negative numbers and integers correctly", () => {
    expect(embeddingToPgVectorLiteral([-0.5, 0, 1])).toBe("[-0.5,0,1]");
  });

  it("handles an empty array", () => {
    expect(embeddingToPgVectorLiteral([])).toBe("[]");
  });

  it("handles a single-element array without a trailing comma", () => {
    expect(embeddingToPgVectorLiteral([0.42])).toBe("[0.42]");
  });
});
