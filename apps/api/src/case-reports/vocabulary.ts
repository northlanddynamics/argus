/** Case Reports (GLOSSARY.md): which variant, in which format. Shared with the SPA. */

/** Complete, or Guest-safe: without any Internal item. Guests export only the Guest-safe one. */
export const REPORT_VARIANTS = ["complete", "guest_safe"] as const;
export type ReportVariant = (typeof REPORT_VARIANTS)[number];
export const reportVariantLabel: Record<ReportVariant, string> = { complete: "Complete", guest_safe: "Guest-safe" };

export const REPORT_FORMATS = ["pdf", "markdown"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const reportFormatLabel: Record<ReportFormat, string> = { pdf: "PDF", markdown: "Markdown" };
