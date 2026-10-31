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

/** What a Case Audit Log entry records. */
export const CASE_AUDIT_ACTIONS = [
  "case.opened",
  "case.status_changed",
  "case.severity_changed",
  "case.case_type_changed",
  "case.assignee_changed",
  "case.summary_edited",
] as const;
export type CaseAuditAction = (typeof CASE_AUDIT_ACTIONS)[number];

/** "C-1041": how a Case is referred to. */
export const caseRef = (number: number) => `C-${number}`;
