import { describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./store";

const ran = {
  matches: [],
  truncated: false,
  bins: [],
  scopeStartUs: 0,
  scopeEndUs: 1000,
  wholeTrace: false,
  elapsedMs: 1,
  targetSignalIds: [],
};

describe("detectorRanSql", () => {
  it("setDetectorQueryResult captures the SQL that was actually run, not any later draft", () => {
    useWorkspaceStore.getState().setDetectorQuerySql("select * from messages");
    useWorkspaceStore.getState().setDetectorQueryResult(ran, "select * from messages where arb_id = 1");
    // The editor draft moved on after the run started, but the overlay must
    // key off what was run, not the live draft - this is what distinguishes
    // the Anomaly Overlay from a per-keystroke recompute.
    useWorkspaceStore.getState().setDetectorQuerySql("select * from messages where arb_id = 1 -- still typing");
    expect(useWorkspaceStore.getState().detectorRanSql).toBe("select * from messages where arb_id = 1");
  });

  it("resetDetectorQuery clears detectorRanSql back to null", () => {
    useWorkspaceStore.getState().setDetectorQueryResult(ran, "select 1");
    useWorkspaceStore.getState().resetDetectorQuery();
    expect(useWorkspaceStore.getState().detectorRanSql).toBeNull();
  });

  it("resetWorkspace clears detectorRanSql back to null", () => {
    useWorkspaceStore.getState().setDetectorQueryResult(ran, "select 1");
    useWorkspaceStore.getState().resetWorkspace();
    expect(useWorkspaceStore.getState().detectorRanSql).toBeNull();
  });

  it("starts as null before any query has run", () => {
    useWorkspaceStore.getState().resetWorkspace();
    expect(useWorkspaceStore.getState().detectorRanSql).toBeNull();
  });
});
