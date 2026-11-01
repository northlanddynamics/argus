import type { AlertKind } from "../alerts/vocabulary";
import type { Severity } from "../cases/vocabulary";
import type { StreamEvent } from "./falcon";

/** The stream's detection events, and the kind of Alert each becomes. Every other event type is ignored. */
export const DETECTION_EVENTS: Record<string, AlertKind> = {
  EppDetectionSummaryEvent: "epp",
  IdpDetectionSummaryEvent: "idp",
  MobileDetectionSummaryEvent: "mobile",
};

/** What an Alert is made of, read from a detection event. */
export type Detection = {
  externalId: string;
  kind: AlertKind;
  severity: Severity;
  title: string;
  description: string | null;
  host: string | null;
  userName: string | null;
  detectedAt: Date | null;
  payload: Record<string, unknown>;
};

const text = (event: Record<string, unknown>, ...fields: string[]) => {
  for (const field of fields) {
    const value = event[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const SEVERITY_NAMES: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  informational: "informational",
  info: "informational",
};

/**
 * The CrowdStrike Severity: `SeverityName` when given, else the number in `Severity`, either on the
 * old 1–5 scale or as a 0–100 score.
 */
export function falconSeverity(event: Record<string, unknown>): Severity {
  const name = text(event, "SeverityName");
  if (name && SEVERITY_NAMES[name.toLowerCase()]) return SEVERITY_NAMES[name.toLowerCase()]!;
  const score = Number(event.Severity);
  if (!Number.isFinite(score)) return "informational";
  if (score <= 5) return (["informational", "informational", "low", "medium", "high", "critical"] as const)[Math.max(0, Math.round(score))]!;
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score >= 20) return "low";
  return "informational";
}

/** The Alert a detection event describes, or null if it isn't one (or has no `CompositeId`). */
export function readDetection({ eventType, event, createdAt }: StreamEvent): Detection | null {
  const kind = DETECTION_EVENTS[eventType];
  const externalId = text(event, "CompositeId");
  if (!kind || !externalId) return null;
  const description = text(event, "Description");
  return {
    externalId,
    kind,
    severity: falconSeverity(event),
    title: text(event, "Name", "DetectName", "Objective") ?? description ?? eventType,
    description,
    host: text(event, "Hostname", "HostName", "ComputerName", "DeviceName", "SourceEndpointHostName"),
    userName: text(event, "UserName", "SourceAccountName", "UserPrincipal"),
    detectedAt: createdAt,
    payload: event,
  };
}
