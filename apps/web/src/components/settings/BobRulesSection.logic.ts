import type { BobRuleKind } from "@t3tools/contracts";

// A command rule is a command's first words, as written: no quotes, wildcards or operators.
const COMMAND_WORDS = /^[A-Za-z0-9_./:=@%+,~^-]+(?: [A-Za-z0-9_./:=@%+,~^-]+)*$/;
// A control character or a broken character no folder name holds, which the sandbox would read
// as some other path.
const CONTROL_OR_LONE_SURROGATE =
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses.
  /[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The value a rule of `kind` saves for what the user typed, or why it cannot be saved. */
export function bobRuleValue(
  kind: BobRuleKind,
  typed: string,
): { readonly value: string } | { readonly error: string } {
  const text = typed.trim();
  if (!text) return { error: "Enter a command or a path." };
  if (kind === "read" || kind === "write" || kind === "private") {
    if (!/^(\/|~$|~\/|\.$|\.\/)/.test(text)) {
      return { error: "Start a path with /, ~/ or ./ for the project's folder." };
    }
    if (CONTROL_OR_LONE_SURROGATE.test(text)) {
      return { error: "Enter a path without control characters." };
    }
    // Writing there would let commands replace the tools that run outside the sandbox, so the
    // server only lets commands read there.
    if (kind === "write" && /^(\/+|~\/*)$/.test(text)) {
      return { error: "Commands may not write in the home folder or above. Name a folder in it." };
    }
    return { value: text };
  }
  const words = text.replace(/\s+/g, " ");
  return COMMAND_WORDS.test(words)
    ? { value: words }
    : { error: "Enter a command's first words, without quotes, wildcards or other commands." };
}
