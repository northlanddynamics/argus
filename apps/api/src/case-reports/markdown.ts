import type { CaseReport } from "./case-reports";
import { type Block, type Item, outline, type Run } from "./outline";

/**
 * A Case Report as CommonMark. Everything taken from the Case is escaped, so it reads as the text
 * it is: it can't add headings, lists, links or HTML of its own.
 */

/** `text` with every character that could start Markdown or HTML escaped. */
export function escapeMarkdown(text: string) {
  return (
    text
      .replace(/[\\`*_{}[\]()<>#+!|~&]/g, (ch) => `\\${ch}`)
      // A line that would otherwise start a list, a quote or a thematic break.
      .replace(/^(\s*)([-=])/gm, "$1\\$2")
      .replace(/^(\s*\d+)([.)])/gm, "$1\\$2")
  );
}

/** A link target that can't end the link early or break out of it. */
const destination = (href: string) => `<${href.replace(/[<>\s\\]/g, (ch) => encodeURIComponent(ch))}>`;

/** Code that holds whatever `text` holds: fenced with more backticks than it contains in a row. */
const code = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((t) => t.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

/** Runs on one line; hard breaks continue the line at `indent`. */
function inline(runs: readonly Run[], indent = "") {
  return runs
    .map((run) => {
      if (run.mono) return code(run.text.replace(/\s*\n\s*/g, " "));
      const lines = run.text.split("\n").map(escapeMarkdown);
      const joined = lines.join(`\\\n${indent}`);
      // Emphasis can't start or end with a space, so spaces at either end stay outside it.
      const [, before, words, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(joined)!;
      if (!words) return joined;
      let out = words;
      if (run.italic) out = `*${out}*`;
      if (run.bold) out = `**${out}**`;
      if (run.href) out = `[${out}](${destination(run.href)})`;
      return `${before}${out}${after}`;
    })
    .join("");
}

/** A body of plain text, its lines kept, indented under its item. */
const body = (text: string, indent: string) =>
  text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `${indent}${escapeMarkdown(line)}` : ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    // Each line its own line, not run together with the next.
    .replace(/([^\n])\n(?=[^\n])/g, "$1\\\n");

function item({ title, details, body: text }: Item) {
  const lines = [`- ${inline(title, "  ")}`, ...details.map((d) => `  - ${inline(d, "    ")}`)];
  if (text?.trim()) lines.push("", body(text, "  "));
  return lines.join("\n");
}

function block(b: Block): string {
  switch (b.kind) {
    case "title":
      return `# ${escapeMarkdown(b.text)}\n\n*${escapeMarkdown(b.subtitle)}*`;
    case "fields":
      return b.fields.map(([label, value]) => `- **${escapeMarkdown(label)}:** ${escapeMarkdown(value)}`).join("\n");
    case "heading":
      return `${"#".repeat(b.level)} ${escapeMarkdown(b.text)}`;
    case "paragraph":
      return inline(b.runs);
    case "bullet":
      return `${"  ".repeat(b.depth)}- ${inline(b.runs, "  ".repeat(b.depth + 1))}`;
    case "note":
      return `*${escapeMarkdown(b.text)}*`;
    case "item":
      return item(b.item);
  }
}

export function toMarkdown(report: CaseReport) {
  const blocks = outline(report);
  let out = "";
  blocks.forEach((b, i) => {
    // Consecutive bullets form one list.
    const together = b.kind === "bullet" && blocks[i - 1]?.kind === "bullet";
    if (i > 0) out += together ? "\n" : "\n\n";
    out += block(b);
  });
  return `${out}\n`;
}
