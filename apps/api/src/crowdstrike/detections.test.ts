import { describe, expect, test } from "bun:test";
import { falconSeverity } from "./detections";

describe("CrowdStrike Severity", () => {
  test("is read from SeverityName, else from the 1–5 scale or the 0–100 score", () => {
    expect(falconSeverity({ SeverityName: "Critical", Severity: 10 })).toBe("critical");
    expect(falconSeverity({ SeverityName: "informational" })).toBe("informational");
    expect([1, 2, 3, 4, 5].map((Severity) => falconSeverity({ Severity }))).toEqual(["informational", "low", "medium", "high", "critical"]);
    expect([10, 30, 50, 70, 90].map((Severity) => falconSeverity({ Severity }))).toEqual(["informational", "low", "medium", "high", "critical"]);
    expect(falconSeverity({})).toBe("informational");
  });
});
