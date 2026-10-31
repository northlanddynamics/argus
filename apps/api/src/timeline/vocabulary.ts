/** What a Timeline Entry can cite, by id. Evidence, Observables and Assets join as they arrive. */
export const CITATION_KINDS = ["task"] as const;
export type Citation = { kind: (typeof CITATION_KINDS)[number]; id: string };

/** What a Timeline Entry can be Promoted from: a Discussion message or a Case Audit Log entry. */
export const PROMOTION_SOURCES = ["discussion_message", "audit_log_entry"] as const;
export type PromotionSource = { kind: (typeof PROMOTION_SOURCES)[number]; id: string };
