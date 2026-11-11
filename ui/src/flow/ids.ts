/** Random id with legacy's alphabet: lowercase hex digits. */
const ALPHABET = '1234567890abcdef'

export function prettyId(length = 10): string {
  let out = ''
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}
