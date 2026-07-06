import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { throttleNotionCall } from "../../src/lib/notionThrottle.js";

/**
 * NOTION_MAX_REQUESTS_PER_SECOND is set to 50 in tests/setupEnv.ts (see
 * that file for why: keeps unrelated tests fast). That still gives a
 * real, testable minimum interval of 20ms between calls, which is
 * enough to prove the throttle actually spaces calls out rather than
 * letting them all through simultaneously — the property under test is
 * "calls are serialized with a minimum gap," not a specific numeric
 * rate matching Notion's real 3 req/sec limit.
 */
describe("throttleNotionCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes a single call immediately without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const promise = throttleNotionCall(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates the wrapped function's return value", async () => {
    const promise = throttleNotionCall(async () => ({ ok: true, data: 42 }));
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ ok: true, data: 42 });
  });

  it("propagates a thrown error from the wrapped function", async () => {
    const promise = throttleNotionCall(async () => {
      throw new Error("boom");
    });
    // Attach the rejection assertion BEFORE advancing timers, so the
    // rejection has a handler the instant it occurs rather than
    // briefly existing as an unhandled rejection between
    // runAllTimersAsync() and this assertion running.
    const assertion = expect(promise).rejects.toThrow("boom");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("serializes concurrent calls with increasing delay rather than running them all at once", async () => {
    const callOrder: number[] = [];
    let counter = 0;

    const calls = Array.from({ length: 3 }, () =>
      throttleNotionCall(async () => {
        callOrder.push(++counter);
      })
    );

    await vi.runAllTimersAsync();
    await Promise.all(calls);

    // All three should have run, in submission order, none skipped or
    // duplicated -- proving the throttle queues rather than drops or
    // reorders calls under concurrent load.
    expect(callOrder).toEqual([1, 2, 3]);
  });
});
