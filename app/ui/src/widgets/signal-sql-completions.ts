import {
  registerCompletions,
  type CompletionResult,
  type CompletionSource,
} from "prism-react-editor/autocomplete";

/** Mutable catalog snapshot read by the SQL completion source (must stay sync). */
let signalNames: readonly string[] = [];

export function setSignalCompletionNames(names: readonly string[]): void {
  signalNames = names;
}

/**
 * Builds the CompletionResult for signal insert.
 *
 * Opening is gated by `explicitOnly: true` on useAutoComplete (Ctrl+Space only).
 * After open, prism re-queries with `explicit: false` on each keystroke — we must
 * still return options then, or the list clears and the tooltip hides.
 */
export function signalCompletionResult(
  lineBefore: string,
  pos: number,
  names: readonly string[]
): CompletionResult | null {
  // ARXML can contain blank names; with an empty query they sort first and the
  // visible window looks like an empty suggestion list.
  const usable = names.filter((name) => name.trim().length > 0);
  if (usable.length === 0) return null;
  const word = /[\w]*$/.exec(lineBefore)?.[0] ?? "";
  return {
    from: pos - word.length,
    options: usable.map((name) => ({
      label: name,
      insert: `'${name.replace(/'/g, "''")}'`,
      icon: "variable",
      detail: "signal",
    })),
  };
}

const signalSource: CompletionSource = (context) =>
  signalCompletionResult(context.lineBefore, context.pos, signalNames);

/** Idempotent: re-registering replaces the previous SQL sources. */
export function registerSignalSqlCompletions(): void {
  registerCompletions(["sql"], { sources: [signalSource] });
}
