const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
/** A backslash escape, or a code span whose closing run matches its opening run. */
const ESCAPE_OR_CODE_SPAN = /\\([!-/:-@[-`{-~])|(?<!`)(`+)(?!`)(.+?)(?<!`)\2(?!`)/g;
const HELD = /\uE000(\d+)\uE001/g;

/**
 * Flattens a markdown snippet to the text a reader sees, for one-line previews
 * of text that renders as markdown elsewhere. Conservative: it drops heading
 * markers, emphasis, code ticks and fences, and link or image syntax, and
 * leaves anything it does not recognize as written. Code keeps its contents.
 */
export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  let openFence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (openFence === null) {
      if (fence) {
        openFence = fence[1]!;
        continue;
      }
      const heading = HEADING.exec(line);
      lines.push(inlinePlainText(heading ? (heading[1] ?? "") : line));
      continue;
    }
    const closesFence =
      fence !== null &&
      fence[1]![0] === openFence[0] &&
      fence[1]!.length >= openFence.length &&
      fence[2]!.trim() === "";
    if (closesFence) {
      openFence = null;
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function inlinePlainText(line: string): string {
  // Escapes and code spans are set aside first so nothing inside them is
  // read as emphasis or link syntax.
  const held: string[] = [];
  const hold = (text: string) => `\uE000${held.push(text) - 1}\uE001`;
  return line
    .replace(
      ESCAPE_OR_CODE_SPAN,
      (_match, escaped: string | undefined, _ticks: string, code: string) =>
        hold(escaped ?? code.replace(/^ (.*\S.*) $/, "$1")),
    )
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^\s<>]+)>/gi, "$1")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/\*(?=[^\s*])(.+?)(?<=[^\s*])\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(HELD, (_match, index: string) => held[Number(index)] ?? "");
}
