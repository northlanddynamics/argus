import { readFileSync } from "node:fs";
import * as samlify from "samlify";

const KEY = readFileSync(new URL("./fixtures/idp-key.pem", import.meta.url), "utf8");
const CERT = readFileSync(new URL("./fixtures/idp-cert.pem", import.meta.url), "utf8");

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The connection named in the AuthnRequest Argus sent the browser to the identity provider with. */
const providerIdOf = (redirect: URL) => {
  const request = new TextDecoder().decode(Bun.inflateSync(Buffer.from(redirect.searchParams.get("SAMLRequest") ?? "", "base64")));
  const providerId = request.match(/AssertionConsumerServiceURL="[^"]*\/acs\/([^"]+)"/)?.[1];
  if (!providerId) throw new Error(`No assertion consumer service in ${request}`);
  return providerId;
};

/** Who the identity provider says signed in. */
export type IdpUser = { email: string; name?: string };

/** What a browser holds after an SSO sign-in attempt: its cookies, and where it was sent. */
type BrowserLike = { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> };

/**
 * A SAML identity provider for tests: what an Admin configures (`metadataXml`, or `entityId`,
 * `ssoUrl` and `certificate`), and `signIn` to play a person signing in through it, from Argus's
 * sign-in redirect to the signed response it posts back.
 */
export function fakeIdp({ entityId = "https://idp.acme.example/saml", baseUrl = "http://argus.test" } = {}) {
  const ssoUrl = `${entityId}/sso`;
  const idp = samlify.IdentityProvider({
    entityID: entityId,
    privateKey: KEY,
    signingCert: CERT,
    nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
    singleSignOnService: [{ Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: ssoUrl }],
  });
  const certificate = CERT;
  const metadataXml = idp.getMetadata();

  /** Argus's service provider for `providerId`, as its published metadata describes it. */
  const serviceProvider = async (browser: BrowserLike, providerId: string) => {
    const res = await browser.fetch(`${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`);
    if (!res.ok) throw new Error(`No service provider metadata for ${providerId}: ${res.status}`);
    return samlify.ServiceProvider({ metadata: await res.text() });
  };

  /** A signed SAML response for `who`, answering `requestId` when there is one. */
  const respond = async (browser: BrowserLike, providerId: string, who: IdpUser, requestId?: string) => {
    const sp = await serviceProvider(browser, providerId);
    const attributes = [
      who.email && `<saml:Attribute Name="email"><saml:AttributeValue>${xmlEscape(who.email)}</saml:AttributeValue></saml:Attribute>`,
      who.name && `<saml:Attribute Name="displayName"><saml:AttributeValue>${xmlEscape(who.name)}</saml:AttributeValue></saml:Attribute>`,
    ].filter(Boolean);
    const { context } = await idp.createLoginResponse(sp, { extract: { request: { id: requestId ?? "" } } }, "post", who, (template) => {
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000).toISOString();
      const acs = `${baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`;
      const id = `_${crypto.randomUUID()}`;
      const values: Record<string, string> = {
        ID: id,
        AssertionID: `_${crypto.randomUUID()}`,
        Destination: acs,
        Audience: sp.entityMeta.getEntityID(),
        SubjectRecipient: acs,
        Issuer: entityId,
        IssueInstant: now.toISOString(),
        StatusCode: "urn:oasis:names:tc:SAML:2.0:status:Success",
        ConditionsNotBefore: now.toISOString(),
        ConditionsNotOnOrAfter: later,
        SubjectConfirmationDataNotOnOrAfter: later,
        NameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        NameID: xmlEscape(who.email),
        InResponseTo: requestId ?? "",
        AuthnStatement: `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`,
        AttributeStatement: attributes.length ? `<saml:AttributeStatement>${attributes.join("")}</saml:AttributeStatement>` : "",
      };
      let xml = template;
      for (const [tag, value] of Object.entries(values)) xml = xml.replaceAll(`{${tag}}`, value);
      if (!requestId) xml = xml.replaceAll(' InResponseTo=""', "");
      return { id, context: xml };
    });
    return context;
  };

  /** Posts a SAML response to Argus's assertion consumer service for `providerId`. */
  const post = (browser: BrowserLike, providerId: string, SAMLResponse: string, RelayState?: string) =>
    browser.fetch(`${baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(RelayState ? { SAMLResponse, RelayState } : { SAMLResponse }),
    });

  /**
   * Asks Argus to start SSO for `email` from `browser`, as the sign-in page does. Returns the
   * connection it chose and the URL it sends the browser to the identity provider with.
   */
  const start = async (browser: BrowserLike, email: string) => {
    const res = await browser.fetch(`${baseUrl}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "/", errorCallbackURL: "/sign-in" }),
    });
    if (!res.ok) return { status: res.status, redirect: null, providerId: null };
    const redirect = new URL(((await res.json()) as { url: string }).url);
    if (`${redirect.origin}${redirect.pathname}` !== ssoUrl) throw new Error(`Sent to ${redirect}, not ${ssoUrl}`);
    return { status: res.status, redirect, providerId: providerIdOf(redirect) };
  };

  /**
   * The identity provider's answer, signing in `who`, to the browser Argus sent to it at `redirect`:
   * where the browser posts it, the signed response, and the RelayState to return.
   */
  const answer = async (browser: BrowserLike, redirect: URL, who: IdpUser) => {
    const providerId = providerIdOf(redirect);
    const sp = await serviceProvider(browser, providerId);
    const request = await idp.parseLoginRequest(sp, "redirect", { query: Object.fromEntries(redirect.searchParams), octetString: "" });
    const requestId = request.extract.request?.id;
    return {
      providerId,
      acsUrl: `${baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`,
      SAMLResponse: await respond(browser, providerId, who, Array.isArray(requestId) ? requestId[0] : requestId),
      RelayState: redirect.searchParams.get("RelayState") ?? undefined,
    };
  };

  /**
   * Signs `who` in from `browser`: asks Argus to start SSO for their email (or the one they typed,
   * `typed`), plays the IdP, and posts its answer back. Returns where Argus sent the browser, and the
   * `error` it named, if any.
   */
  const signIn = async (browser: BrowserLike, who: IdpUser, typed = who.email) => {
    const { status, redirect } = await start(browser, typed);
    if (!redirect) return { status, error: "no_connection", location: null };
    const { providerId, SAMLResponse, RelayState } = await answer(browser, redirect, who);
    const res = await post(browser, providerId, SAMLResponse, RelayState);
    const location = new URL(res.headers.get("location") ?? "", baseUrl);
    return { status: res.status, error: location.searchParams.get("error"), location: `${location.pathname}${location.search}` };
  };

  return { entityId, ssoUrl, certificate, metadataXml, start, answer, signIn, respond, post };
}
