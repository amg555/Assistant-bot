import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordUndoableAction, takeUndoableAction } from "../../src/lib/undoStore.js";

describe("undoStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when nothing has been recorded for an account", () => {
    expect(takeUndoableAction("account-with-no-history")).toBeNull();
  });

  it("returns the recorded action when taken within the TTL window", () => {
    recordUndoableAction("acct-1", { kind: "delete_note", noteId: "note-123" });
    expect(takeUndoableAction("acct-1")).toEqual({ kind: "delete_note", noteId: "note-123" });
  });

  it("clears the action after it's been taken once (no double-undo)", () => {
    recordUndoableAction("acct-1", { kind: "delete_task", taskId: "task-1" });
    expect(takeUndoableAction("acct-1")).not.toBeNull();
    expect(takeUndoableAction("acct-1")).toBeNull();
  });

  it("keeps different accounts' undo actions fully isolated", () => {
    recordUndoableAction("acct-1", { kind: "delete_task", taskId: "task-1" });
    recordUndoableAction("acct-2", { kind: "delete_task", taskId: "task-2" });

    expect(takeUndoableAction("acct-1")).toEqual({ kind: "delete_task", taskId: "task-1" });
    expect(takeUndoableAction("acct-2")).toEqual({ kind: "delete_task", taskId: "task-2" });
  });

  it("overwrites a previous action if a new one is recorded before it's taken", () => {
    recordUndoableAction("acct-1", { kind: "delete_note", noteId: "first" });
    recordUndoableAction("acct-1", { kind: "delete_note", noteId: "second" });
    expect(takeUndoableAction("acct-1")).toEqual({ kind: "delete_note", noteId: "second" });
  });

  it("expires an action after the TTL window and reports nothing to undo", () => {
    recordUndoableAction("acct-1", { kind: "delete_note", noteId: "note-1" });

    // Advance past the 5-minute TTL.
    vi.setSystemTime(new Date("2026-07-05T12:06:00.000Z"));

    expect(takeUndoableAction("acct-1")).toBeNull();
  });

  it("still returns the action right at the edge of, but within, the TTL", () => {
    recordUndoableAction("acct-1", { kind: "delete_note", noteId: "note-1" });

    // 4 minutes 59 seconds later -- still within the 5-minute window.
    vi.setSystemTime(new Date("2026-07-05T12:04:59.000Z"));

    expect(takeUndoableAction("acct-1")).toEqual({ kind: "delete_note", noteId: "note-1" });
  });

  it("preserves the full action payload for restore_reminder_time", () => {
    recordUndoableAction("acct-1", {
      kind: "restore_reminder_time",
      reminderId: "rem-1",
      previousRemindAt: "2026-07-05T09:00:00.000Z",
    });
    expect(takeUndoableAction("acct-1")).toEqual({
      kind: "restore_reminder_time",
      reminderId: "rem-1",
      previousRemindAt: "2026-07-05T09:00:00.000Z",
    });
  });
});
