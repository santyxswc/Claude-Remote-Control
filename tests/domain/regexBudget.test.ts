import { describe, expect, test } from 'bun:test'
import { DEFAULT_RISK_RULES } from '../../src/domain/permissions/RiskPolicy.ts'
import { KNOWN_SECRET_PATTERNS } from '../../src/domain/redaction/secretDetectors.ts'

/**
 * L2: every risk rule and secret detector stays fast on adversarial input
 * (repeated prefixes that made unbounded regexes backtrack for seconds).
 * The inputs are larger than anything the bridge forwards, the budget is
 * loose (about 20x what a bounded rule takes on a slow CI runner), and a
 * warm-up run keeps JIT compilation out of the measurement.
 */
const BUDGET_MS = 100

const RISK_INPUTS: Record<string, string> = {
  gitpush: 'git push '.repeat(20_000 / 9),
  gitreset: 'git reset '.repeat(2_000),
  gitclean: 'git clean '.repeat(2_000),
  gitbranch: 'git branch '.repeat(2_000),
  find: 'find -exec '.repeat(2_000),
  dd: 'dd '.repeat(7_000),
  chmod: 'chmod -R '.repeat(2_000),
  curl: 'curl | '.repeat(3_000),
  rm: 'rm -a '.repeat(3_500),
  rd: 'rd '.repeat(7_000),
  update: 'update t set '.repeat(1_600),
  redirect: '> ~'.repeat(7_000),
  python: 'python -x '.repeat(2_000),
  dots: 'a.'.repeat(10_000),
  backslashes: '\\'.repeat(20_000),
}

const SECRET_INPUTS: Record<string, string> = {
  urlDots: 'a.'.repeat(50_000),
  urlDash: 'a-'.repeat(50_000),
  urlScheme: `a://${'x'.repeat(100_000)}`,
  urlSchemes: 'a://x'.repeat(20_000),
  urlUser: `a://${'u:'.repeat(50_000)}`,
  pem: '-----BEGIN '.repeat(9_000),
  pemA: `-----BEGIN ${'A '.repeat(50_000)}`,
  bearer: 'Bearer '.repeat(14_000),
  bearerA: `Bearer ${'a'.repeat(100_000)}`,
  sk: `sk-${'a'.repeat(100_000)}`,
  skMany: ' sk-aaaaaaaaaaaaaaaaaaaaaaa'.repeat(4_000),
  jwt: `eyJ${'a'.repeat(100_000)}`,
  jwtdot: 'eyJaaaaaaaaa.'.repeat(8_000),
  digits: '1'.repeat(100_000),
  digitsColon: '12345:'.repeat(16_000),
}

function elapsed(run: () => unknown): number {
  run()
  const start = performance.now()
  run()
  return performance.now() - start
}

describe('L2: regex budget', () => {
  for (const rule of DEFAULT_RISK_RULES) {
    test(`risk rule ${rule.id}`, () => {
      for (const [name, input] of Object.entries(RISK_INPUTS)) {
        expect({ name, ms: elapsed(() => rule.matches(input)) < BUDGET_MS }).toEqual({
          name,
          ms: true,
        })
      }
    })
  }

  for (const detector of KNOWN_SECRET_PATTERNS) {
    test(`secret detector ${detector.name}`, () => {
      for (const [name, input] of Object.entries(SECRET_INPUTS)) {
        expect({ name, ms: elapsed(() => [...detector.find(input)]) < BUDGET_MS }).toEqual({
          name,
          ms: true,
        })
      }
    })
  }
})
