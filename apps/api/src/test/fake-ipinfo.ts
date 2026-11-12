import type { IpDetails, IpinfoConnector } from "../ipinfo/ipinfo";
import { EMPTY_IP_DETAILS, IpinfoQuotaExceeded, IpinfoRefused } from "../ipinfo/ipinfo";

/**
 * A fake IPinfo for tests: answers every token's lookups from `details` (by address), with made-up
 * details for any address it wasn't given. It records every lookup with the token it was made with,
 * and can refuse a token, run out of quota, be unreachable, or call addresses bogons.
 */
export function fakeIpinfo() {
  const fake = {
    /** Every lookup, in order. */
    lookups: [] as { token: string; ip: string }[],
    /** What it says about particular addresses. */
    details: new Map<string, Partial<IpDetails>>(),
    /** Addresses it calls bogons. */
    bogons: new Set<string>(),
    /** Tokens it refuses, as IPinfo does wrong or revoked ones. */
    refused: new Set<string>(),
    /** Set to answer every lookup with 429. */
    quotaExceeded: false,
    /** Set to make every lookup fail with this message, as when IPinfo can't be reached. */
    unreachable: null as string | null,
  };

  const connect: IpinfoConnector = ({ token }) => ({
    async lookup(ip) {
      fake.lookups.push({ token, ip });
      if (fake.unreachable) throw new Error(fake.unreachable);
      if (fake.refused.has(token)) throw new IpinfoRefused("IPinfo refused the API token");
      if (fake.quotaExceeded) throw new IpinfoQuotaExceeded("IPinfo's lookup quota for this token is used up");
      if (fake.bogons.has(ip)) return { bogon: true };
      return {
        bogon: false,
        details: {
          ...EMPTY_IP_DETAILS,
          city: "Frankfurt am Main",
          region: "Hesse",
          regionCode: "HE",
          country: "Germany",
          countryCode: "DE",
          continent: "Europe",
          continentCode: "EU",
          latitude: 50.1155,
          longitude: 8.6842,
          accuracyRadius: 20,
          timezone: "Europe/Berlin",
          postalCode: "60306",
          geonameId: "2925533",
          locationChangedOn: "2025-03-14",
          asn: "AS60729",
          asName: "Example Hosting GmbH",
          asDomain: "example-hosting.de",
          asType: "hosting",
          asChangedOn: "2024-11-02",
          hosting: true,
          ...fake.details.get(ip),
        },
      };
    },
  });

  return Object.assign(fake, { connect });
}
