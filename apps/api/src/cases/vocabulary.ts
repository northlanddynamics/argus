/** The fixed lists a Case is described with (GLOSSARY.md), as stored codes and their display names. */

export const STATUSES = ["new", "triage", "in_progress", "awaiting_info", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];
export const statusLabel: Record<Status, string> = {
  new: "New",
  triage: "Triage",
  in_progress: "In Progress",
  awaiting_info: "Awaiting Info",
  resolved: "Resolved",
  closed: "Closed",
};

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityLabel: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

export const CASE_TYPES = [
  "phishing",
  "malware",
  "account_compromise",
  "unauthorized_access",
  "data_loss",
  "insider_threat",
  "denial_of_service",
  "vulnerability",
  "other",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];
export const caseTypeLabel: Record<CaseType, string> = {
  phishing: "Phishing",
  malware: "Malware",
  account_compromise: "Account Compromise",
  unauthorized_access: "Unauthorized Access",
  data_loss: "Data Loss",
  insider_threat: "Insider Threat",
  denial_of_service: "Denial of Service",
  vulnerability: "Vulnerability",
  other: "Other",
};

/** The outcome recorded when a Case is closed. */
export const RESOLUTIONS = ["true_positive", "benign", "false_positive", "duplicate"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const resolutionLabel: Record<Resolution, string> = {
  true_positive: "True Positive",
  benign: "Benign",
  false_positive: "False Positive",
  duplicate: "Duplicate",
};

/** The Status a Case returns to when an Admin reopens it. */
export const REOPENED_STATUS = "in_progress" satisfies Status;

/** What a Case Audit Log entry records. */
export const CASE_AUDIT_ACTIONS = [
  "case.opened",
  "case.status_changed",
  "case.severity_changed",
  "case.case_type_changed",
  "case.assignee_changed",
  "case.restricted_changed",
  "case.summary_edited",
  "case.closed",
  "case.reopened",
  "task.created",
  "task.title_changed",
  "task.description_changed",
  "task.owner_changed",
  "task.due_date_changed",
  "task.completed",
  "task.reopened",
  "case_role.assigned",
  "case_role.unassigned",
  "discussion.message_posted",
  "discussion.message_edited",
  "discussion.message_retracted",
  "timeline.entry_added",
  "timeline.entry_promoted",
  "timeline.entry_edited",
  "timeline.entry_retracted",
  "evidence.added",
  "evidence.viewed",
  "evidence.downloaded",
  "guest.invited",
  "guest.removed",
  "observable.linked",
  "observable.unlinked",
  "asset.linked",
  "asset.unlinked",
  "case_link.added",
  "case_link.removed",
  "tag.added",
  "tag.removed",
] as const;
export type CaseAuditAction = (typeof CASE_AUDIT_ACTIONS)[number];

/** "C-1041": how a Case is referred to. */
export const caseRef = (number: number) => `C-${number}`;
