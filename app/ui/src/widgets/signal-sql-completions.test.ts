import { describe, expect, it } from "vitest";
import { signalCompletionResult } from "./signal-sql-completions";

describe("signalCompletionResult", () => {
  const names = ["VDSO_04_BZ", "FOO_BAR", "O'Brien"];

  it("returns null when catalog is empty", () => {
    expect(signalCompletionResult("", 0, [])).toBeNull();
  });

  it("skips blank signal names so they cannot fill the visible window", () => {
    const result = signalCompletionResult("", 0, ["", "  ", "VDSO_04_BZ"]);
    expect(result?.options.map((o) => o.label)).toEqual(["VDSO_04_BZ"]);
  });

  it("returns null when every name is blank", () => {
    expect(signalCompletionResult("", 0, ["", "  "])).toBeNull();
  });

  it("inserts at cursor with no word prefix", () => {
    const result = signalCompletionResult("where name = ", 13, names);
    expect(result?.from).toBe(13);
    expect(result?.options[0]).toMatchObject({
      label: "VDSO_04_BZ",
      insert: "'VDSO_04_BZ'",
    });
  });

  it("replaces the word prefix before the cursor", () => {
    const line = "where name = VDSO";
    const result = signalCompletionResult(line, line.length, names);
    expect(result?.from).toBe(line.length - "VDSO".length);
  });

  it("SQL-escapes single quotes in signal names", () => {
    const result = signalCompletionResult("", 0, names);
    const item = result?.options.find((o) => o.label === "O'Brien");
    expect(item?.insert).toBe("'O''Brien'");
  });
});
