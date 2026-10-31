/** An unguessable id (192 bits), safe to use as a bearer token in links. */
export const secureId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
