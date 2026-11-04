/** What a Teams channel post announces. */
export const TEAMS_POST_KINDS = [
  /** A Case was opened as Critical, or opened from Alerts (at any Severity). */
  "case_opened",
  /** A Case's Severity was raised to Critical. */
  "severity_critical",
] as const;
export type TeamsPostKind = (typeof TEAMS_POST_KINDS)[number];
