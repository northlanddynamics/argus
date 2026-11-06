import { describe, expect, test } from "bun:test";
import epp from "./fixtures/epp-detection.json";
import idp from "./fixtures/idp-detection.json";
import mobile from "./fixtures/mobile-detection.json";
import { extractIndicators } from "./indicators";

const shown = (event: Record<string, unknown>) => {
  const { observables, assets } = extractIndicators(event);
  return {
    observables: observables.map((o) => `${o.type} ${o.value}`),
    assets: assets.map((a) => `${a.type} ${a.value}`),
  };
};

describe("Observables and Assets from CrowdStrike detections", () => {
  test("an endpoint detection names its hashes, remote addresses, DNS lookups, host and user", () => {
    expect(shown(epp)).toEqual({
      observables: [
        "sha256 7f3a9c0e5b2d4a6f8e1c3b5d7a9f0e2c4b6d8a0f1e3c5b7d9a1f3e5c7b9d1c91",
        "md5 7353f60b1739074eb17c5f4dddefe239",
        "ip 185.220.101.4",
        "domain invoice-portal.biz",
      ],
      assets: ["host FIN-LT-0231", "account d.howe"],
    });
  });

  test("an identity detection names the source address, both endpoints and both accounts", () => {
    expect(shown(idp)).toEqual({
      observables: ["ip 185.220.101.4"],
      assets: ["host FIN-LT-0231", "host DC01.acme.corp", "account d.howe", "account svc-backup"],
    });
  });

  test("a mobile detection names its app's hash, its lookups and connections, the device and its user", () => {
    expect(shown(mobile)).toEqual({
      observables: [
        "sha256 c4d8e2f6a0b4c8d2e6f0a4b8c2d6e0f4a8b2c6d0e4f8a2b6c0d4e8f2a6b0c4d8",
        "domain cdn.flashlight-pro.app",
        "ip 203.0.113.50",
      ],
      assets: ["host Pixel-8-MC", "account m.chen@acme.example"],
    });
  });

  test("the host's own addresses, Falcon's placeholders and invalid values are left out", () => {
    const { observables } = extractIndicators({
      LocalIP: "10.0.0.5",
      ExternalIP: "198.51.100.7",
      SHA1String: "0000000000000000000000000000000000000000",
      MD5String: "not-a-hash",
      NetworkAccesses: [{ LocalAddress: "10.0.0.5", RemoteAddress: "::" }],
    });
    expect(observables).toEqual([]);
  });

  test("an IOC is read by its IOCType", () => {
    expect(shown({ IOCType: "domain", IOCValue: "evil[.]example" }).observables).toEqual(["domain evil.example"]);
  });

  test("an endpoint or mobile detection names its sensor's device ID for its host", () => {
    expect(extractIndicators(epp).devices).toEqual([{ hostKey: "fin-lt-0231", deviceId: "8f1c2b3a4d5e6f708192a3b4c5d6e7f8" }]);
    expect(extractIndicators(mobile).devices).toEqual([{ hostKey: "pixel-8-mc", deviceId: "3c7e9a1b2d4f6a8c0e2b4d6f8a1c3e5b" }]);
  });

  test("an identity detection names the device ID of each endpoint it has one for", () => {
    expect(extractIndicators(idp).devices).toEqual([{ hostKey: "fin-lt-0231", deviceId: "8f1c2b3a4d5e6f708192a3b4c5d6e7f8" }]);
    expect(
      extractIndicators({ ...idp, TargetEndpointSensorId: "AAAABBBBCCCCDDDDEEEEFFFF00001111" }).devices.map((d) => `${d.hostKey} ${d.deviceId}`),
    ).toEqual(["fin-lt-0231 8f1c2b3a4d5e6f708192a3b4c5d6e7f8", "dc01.acme.corp aaaabbbbccccddddeeeeffff00001111"]);
  });

  test("no device is named without an aid, without a host, or with an aid that isn't one", () => {
    const { AgentId: _, ...withoutAid } = epp;
    expect(extractIndicators(withoutAid).devices).toEqual([]);
    expect(extractIndicators({ AgentId: epp.AgentId }).devices).toEqual([]);
    expect(extractIndicators({ ...epp, AgentId: "not-an-aid" }).devices).toEqual([]);
  });
});
