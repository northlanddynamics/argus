/**
 * Integration credentials at rest: sealed with AES-256-GCM under a key derived from the server's
 * credentials secret, so a database dump alone doesn't reveal them. Only the worker opens them, to
 * connect to Falcon; the API never sends them back out.
 */

export type CredentialSealer = {
  seal(plaintext: string): Promise<string>;
  /** Throws if `sealed` was not sealed under this key, or has been altered. */
  open(sealed: string): Promise<string>;
};

const FORMAT = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Seals and opens with a key derived from `secret`. */
export function credentialSealer(secret: string): CredentialSealer {
  const key = (async () => {
    const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("argus integration credentials") },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  return {
    async seal(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, encoder.encode(plaintext));
      return [FORMAT, toBase64(iv), toBase64(new Uint8Array(ciphertext))].join(".");
    },
    async open(sealed) {
      const [format, iv, ciphertext] = sealed.split(".");
      if (format !== FORMAT || !iv || !ciphertext) throw new Error("Not sealed credentials");
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await key, fromBase64(ciphertext));
      return decoder.decode(plaintext);
    },
  };
}
