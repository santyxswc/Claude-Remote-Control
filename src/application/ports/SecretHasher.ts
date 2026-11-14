/**
 * One-way hashing of short-lived secrets such as pairing codes, so only a
 * hash is ever stored. Lives behind a port because the domain and the
 * application cannot import crypto builtins.
 */
export interface SecretHasher {
  hash(secret: string): string
  /** Compares `secret` against a stored hash in constant time. */
  matches(secret: string, hash: string): boolean
}
