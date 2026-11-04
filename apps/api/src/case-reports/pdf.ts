import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { caseRef } from "../cases/vocabulary";
import type { CaseReport } from "./case-reports";
import { type Block, outline, type Run } from "./outline";
import { reportVariantLabel } from "./vocabulary";

/**
 * A Case Report as an A4 PDF, drawn from the report's outline. Text is set in DejaVu Sans, embedded
 * and subset, so any character the Case holds (arrows, accents, Cyrillic) prints as itself.
 */

/** Bun's file reader, declared so the SPA, which type-checks the API, needn't know Bun. */
declare const Bun: { file(path: URL): { arrayBuffer(): Promise<ArrayBuffer> } };
/** Where a package's file is, as a file URL. */
const resolve = (id: string) => new URL((import.meta as ImportMeta & { resolve(id: string): string }).resolve(id));

const FONT_FILES = {
  regular: "DejaVuSans.ttf",
  bold: "DejaVuSans-Bold.ttf",
  italic: "DejaVuSans-Oblique.ttf",
  boldItalic: "DejaVuSans-BoldOblique.ttf",
  mono: "DejaVuSansMono.ttf",
} as const;
type FontName = keyof typeof FONT_FILES;

/** The font files' bytes, read once. */
let fontBytes: Promise<Record<FontName, ArrayBuffer>> | undefined;
const loadFonts = () =>
  (fontBytes ??= Promise.all(
    Object.entries(FONT_FILES).map(async ([name, file]) => {
      return [name, await Bun.file(resolve(`dejavu-fonts-ttf/ttf/${file}`)).arrayBuffer()] as const;
    }),
  ).then((entries) => Object.fromEntries(entries) as Record<FontName, ArrayBuffer>));

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { x: 56, top: 60, bottom: 64 };
const WIDTH = PAGE.width - 2 * MARGIN.x;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.4, 0.45);
const LINK = rgb(0.1, 0.3, 0.75);
const RULE = rgb(0.82, 0.84, 0.87);

type Fonts = Record<FontName, PDFFont>;
/** A run once its font is known. */
type Piece = { text: string; font: PDFFont; color: ReturnType<typeof rgb> };
type Style = { size: number; color?: ReturnType<typeof rgb>; bold?: boolean; italic?: boolean };

/** Characters a PDF can't show as text: control characters other than the line breaks handled here. */
const printable = (text: string) =>
  [...text.replace(/\t/g, "    ")].filter((ch) => ch === "\n" || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)).join("");

class Layout {
  private page!: PDFPage;
  private y = 0;
  readonly pages: PDFPage[] = [];

  private readonly doc: PDFDocument;
  private readonly fonts: Fonts;

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN.top;
  }

  /** Moves down by `height`, starting a new page first if it wouldn't fit. */
  private advance(height: number) {
    if (this.y - height < MARGIN.bottom) this.newPage();
    this.y -= height;
  }

  space(height: number) {
    if (this.y - height < MARGIN.bottom) this.newPage();
    else this.y -= height;
  }

  /** Keeps the next `height` together on one page, so a heading isn't left alone at the bottom. */
  keep(height: number) {
    if (this.y - height < MARGIN.bottom) this.newPage();
  }

  private fontFor(run: Run, style: Style) {
    if (run.mono) return this.fonts.mono;
    const bold = run.bold ?? style.bold;
    const italic = run.italic ?? style.italic;
    return bold && italic ? this.fonts.boldItalic : bold ? this.fonts.bold : italic ? this.fonts.italic : this.fonts.regular;
  }

  /**
   * Draws `runs` as wrapped lines from `indent` to the right margin; `lead` (a bullet) hangs in
   * front of the first line. Words too long for a line are broken where they reach its end.
   */
  text(runs: readonly Run[], style: Style, indent = 0, lead?: string) {
    const { size } = style;
    const lineHeight = size * 1.4;
    const width = WIDTH - indent;
    const lines: Piece[][] = [[]];
    let used = 0;
    const measure = (p: Piece) => p.font.widthOfTextAtSize(p.text, size);
    const push = (piece: Piece) => {
      lines.at(-1)!.push(piece);
      used += measure(piece);
    };
    const breakLine = () => {
      lines.push([]);
      used = 0;
    };

    for (const run of runs) {
      const font = this.fontFor(run, style);
      const color = run.href ? LINK : (style.color ?? INK);
      const paragraphs = printable(run.text).split(/\r?\n/);
      paragraphs.forEach((paragraph, p) => {
        if (p > 0) breakLine();
        // Words with the spaces after them, so a line can break between any two.
        for (const word of paragraph.match(/\S+\s*|\s+/g) ?? []) {
          const piece = { text: word, font, color };
          if (used + font.widthOfTextAtSize(word.trimEnd(), size) <= width) {
            push(piece);
            continue;
          }
          if (used > 0 && font.widthOfTextAtSize(word.trimEnd(), size) <= width) {
            breakLine();
            if (word.trim()) push({ ...piece, text: word });
            continue;
          }
          // Longer than a whole line: break it by characters.
          let rest = word;
          while (rest) {
            let fits = 0;
            while (fits < rest.length && used + font.widthOfTextAtSize(rest.slice(0, fits + 1), size) <= width) fits++;
            if (fits === 0) {
              if (used === 0) fits = 1;
              else {
                breakLine();
                continue;
              }
            }
            push({ ...piece, text: rest.slice(0, fits) });
            rest = rest.slice(fits);
            if (rest) breakLine();
          }
        }
      });
    }

    lines.forEach((line, i) => {
      this.advance(lineHeight);
      const baseline = this.y + (lineHeight - size) / 2 + size * 0.2;
      if (i === 0 && lead) {
        const leadWidth = this.fonts.regular.widthOfTextAtSize(lead, size);
        this.page.drawText(lead, { x: MARGIN.x + indent - leadWidth - 4, y: baseline, size, font: this.fonts.regular, color: style.color ?? INK });
      }
      let x = MARGIN.x + indent;
      for (const piece of line) {
        const shown = piece === line.at(-1) ? piece.text.trimEnd() : piece.text;
        if (shown) this.page.drawText(shown, { x, y: baseline, size, font: piece.font, color: piece.color });
        x += measure(piece);
      }
    });
  }

  rule() {
    this.advance(8);
    this.page.drawLine({
      start: { x: MARGIN.x, y: this.y + 4 },
      end: { x: PAGE.width - MARGIN.x, y: this.y + 4 },
      thickness: 0.6,
      color: RULE,
    });
  }

  /** Writes "C-12 · Guest-safe Case Report · Page 1 of 3" at the foot of every page. */
  footers(label: string) {
    this.pages.forEach((page, i) => {
      const footer = `${label} · Page ${i + 1} of ${this.pages.length}`;
      page.drawText(footer, { x: MARGIN.x, y: MARGIN.bottom / 2, size: 8, font: this.fonts.regular, color: MUTED });
    });
  }
}

/** Runs with each link's address after it, since a printed link can't be followed. */
const withAddresses = (runs: readonly Run[]): Run[] =>
  runs.flatMap((run) => (run.href && run.href !== run.text ? [run, { text: ` (${run.href})`, italic: run.italic }] : [run]));

function draw(layout: Layout, b: Block) {
  switch (b.kind) {
    case "title":
      layout.text([{ text: b.text }], { size: 20, bold: true });
      layout.space(2);
      layout.text([{ text: b.subtitle }], { size: 10.5, italic: true, color: MUTED });
      layout.space(8);
      return;
    case "fields":
      for (const [label, value] of b.fields) layout.text([{ text: `${label}: `, bold: true }, { text: value }], { size: 10 });
      return;
    case "heading":
      if (b.level <= 2) {
        layout.space(14);
        layout.keep(60);
        layout.text([{ text: b.text }], { size: 14, bold: true });
        layout.rule();
      } else {
        layout.space(6);
        layout.keep(40);
        layout.text([{ text: b.text }], { size: 11.5, bold: true });
      }
      return;
    case "paragraph":
      layout.space(3);
      layout.text(withAddresses(b.runs), { size: 10 });
      return;
    case "bullet":
      layout.space(1);
      layout.text(withAddresses(b.runs), { size: 10 }, 14 + b.depth * 14, b.depth % 2 ? "◦" : "•");
      return;
    case "note":
      layout.space(3);
      layout.text([{ text: b.text }], { size: 9.5, italic: true, color: MUTED });
      return;
    case "item": {
      layout.space(7);
      layout.keep(50);
      layout.text(b.item.title, { size: 10.5 });
      for (const detail of b.item.details) layout.text(detail, { size: 9, color: MUTED }, 12);
      if (b.item.body?.trim()) {
        layout.space(2);
        layout.text([{ text: b.item.body.trim() }], { size: 10 }, 12);
      }
      return;
    }
  }
}

export async function toPdf(report: CaseReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = await loadFonts();
  const entries = await Promise.all(
    (Object.keys(FONT_FILES) as FontName[]).map(async (name) => [name, await doc.embedFont(bytes[name], { subset: true })] as const),
  );
  const fonts = Object.fromEntries(entries) as Fonts;

  const ref = caseRef(report.case.number);
  const variant = `${reportVariantLabel[report.variant]} Case Report`;
  const at = new Date(report.generatedAt);
  doc.setTitle(`${ref}: ${report.case.title}`);
  doc.setSubject(variant);
  doc.setAuthor(report.generatedBy);
  doc.setCreator("Argus");
  doc.setProducer("Argus");
  doc.setCreationDate(at);
  doc.setModificationDate(at);

  const layout = new Layout(doc, fonts);
  for (const b of outline(report)) draw(layout, b);
  layout.footers(`${ref} · ${variant} · Generated ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC`);
  return doc.save();
}
