import type { SecretDetector, SecretSpan } from './SecretRedactor.ts'

/**
 * Finds every match of a global regular expression. With `group`, only that
 * capture group is the secret (for example the token after `Bearer `), so
 * the surrounding context stays readable.
 */
export class PatternDetector implements SecretDetector {
  readonly #pattern: RegExp

  constructor(
    readonly name: string,
    pattern: RegExp,
    private readonly group = 0,
  ) {
    const flags = new Set(pattern.flags)
    flags.add('g')
    flags.add('d') // match indices, to locate capture groups
    this.#pattern = new RegExp(pattern.source, [...flags].join(''))
  }

  *find(text: string): Iterable<SecretSpan> {
    for (const match of text.matchAll(this.#pattern)) {
      const range = match.indices?.[this.group]
      if (range !== undefined) yield { start: range[0], end: range[1] }
    }
  }
}

/** Every occurrence of known literal values, such as the bot token or `.env` values. */
export class ExactValueDetector implements SecretDetector {
  readonly name = 'exact-value'
  readonly #values: readonly string[]

  constructor(values: readonly string[]) {
    this.#values = [...new Set(values)].filter((value) => value.length > 0)
  }

  *find(text: string): Iterable<SecretSpan> {
    for (const value of this.#values) {
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
        yield { start: at, end: at + value.length }
      }
    }
  }
}

/** No identifier character right before: `task-...` must not look like `sk-...`. */
const START = '(?<![A-Za-z0-9_-])'

/**
 * Credentials recognizable by shape. Each rule needs a distinctive prefix or
 * structure so ordinary prose, git SHAs, UUIDs and paths pass through.
 */
export const KNOWN_SECRET_PATTERNS: readonly SecretDetector[] = [
  // Whole PEM private key blocks; a block cut off before its END line is redacted to the end.
  new PatternDetector(
    'pem-private-key',
    /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----|$)/,
  ),
  new PatternDetector('anthropic', new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}`)),
  // OpenAI (`sk-`, `sk-proj-`, ...); a digit is required so `sk-some-long-css-class` survives.
  new PatternDetector(
    'openai',
    new RegExp(
      `${START}sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]{0,4096}\\d)[A-Za-z0-9_-]{20,}`,
    ),
  ),
  new PatternDetector(
    'github',
    /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  ),
  new PatternDetector('gitlab', new RegExp(`${START}glpat-[A-Za-z0-9_-]{20,}`)),
  new PatternDetector('slack', new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`)),
  new PatternDetector('aws-access-key-id', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/),
  new PatternDetector('google-api-key', new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`)),
  new PatternDetector('stripe', /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/),
  new PatternDetector('npm', /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/),
  // `<bot id>:<secret>` as issued by BotFather.
  new PatternDetector('telegram-bot-token', /(?<![A-Za-z0-9_:-])\d{5,20}:[A-Za-z0-9_-]{30,}/),
  // header.payload.signature, both JSON parts starting with `{"` (base64url `eyJ`).
  new PatternDetector(
    'jwt',
    new RegExp(
      `${START}eyJ[A-Za-z0-9_-]{8,8192}\\.eyJ[A-Za-z0-9_-]{8,16384}\\.[A-Za-z0-9_-]{0,8192}`,
    ),
  ),
  // `Bearer <token>`: only the token goes; it must contain a digit so prose survives.
  new PatternDetector(
    'bearer-token',
    /\bBearer\s+((?=[A-Za-z0-9._~+/=-]{0,4096}\d)[A-Za-z0-9._~+/=-]{16,})/i,
    1,
  ),
  // `scheme://user:password@host`: only the password goes. A scheme starts only where
  // no scheme character precedes it, and every part is bounded (L2: no backtracking).
  new PatternDetector(
    'url-credentials',
    /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:@/?#]{1,256}:([^\s@/?#]{1,256})@/,
    1,
  ),
]
