import { describe, expect, test } from 'bun:test'
import {
  REDACTION_MARK,
  type SecretDetector,
  SecretRedactor,
} from '../../../src/domain/redaction/SecretRedactor.ts'
import {
  ExactValueDetector,
  KNOWN_SECRET_PATTERNS,
  PatternDetector,
} from '../../../src/domain/redaction/secretDetectors.ts'
import {
  createSecretRedactor,
  selectSecretValues,
} from '../../../src/domain/redaction/secretValues.ts'

// Fixtures are assembled at runtime so no credential-shaped literal sits in the repository.
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const FAKE = {
  anthropic: `sk-ant-api03-${rep('Ab3dE', 40)}`,
  openai: `sk-${rep('a1B2c3', 48)}`,
  openaiProject: `sk-proj-${rep('Zx9_Yw8-', 40)}`,
  ghp: `ghp_${rep('a1B2', 36)}`,
  gho: `gho_${rep('Q7r8', 36)}`,
  ghs: `ghs_${rep('m3N4', 36)}`,
  ghu: `ghu_${rep('k5L6', 36)}`,
  githubPat: `github_pat_${rep('11ABC_def', 82)}`,
  gitlab: `glpat-${rep('x1Y2-z', 20)}`,
  slack: `xoxb-${rep('1234567890-', 40)}`,
  awsAkia: `AKIA${rep('IOSFODNN7', 16)}`,
  awsAsia: `ASIA${rep('Z2X3C4V5', 16)}`,
  google: `AIza${rep('Sy9-xW_8v', 35)}`,
  stripeLive: `sk_live_${rep('4eC39HqLyjWDarjtT1', 24)}`,
  stripeRestricted: `rk_live_${rep('9fG4hJ2k', 24)}`,
  npm: `npm_${rep('aB3cD4eF5', 36)}`,
  telegram: `7123456789:${rep('AAEh-k2_Lm9', 35)}`,
  jwt: `eyJ${rep('hbGciOiJIUzI1NiJ9', 20)}.eyJ${rep('zdWIiOiIxMjM0In0', 24)}.${rep('SflKxwRJSMeKKF2QT4fwpM', 43)}`,
} as const

const redactor = createSecretRedactor([])

function only(name: string): SecretRedactor {
  const detector = KNOWN_SECRET_PATTERNS.find((d) => d.name === name)
  if (detector === undefined) throw new Error(`no detector ${name}`)
  return new SecretRedactor([detector])
}

describe('known credential shapes', () => {
  test.each([
    ['anthropic', FAKE.anthropic],
    ['openai', FAKE.openai],
    ['openai', FAKE.openaiProject],
    ['github', FAKE.ghp],
    ['github', FAKE.gho],
    ['github', FAKE.ghs],
    ['github', FAKE.ghu],
    ['github', FAKE.githubPat],
    ['gitlab', FAKE.gitlab],
    ['slack', FAKE.slack],
    ['aws-access-key-id', FAKE.awsAkia],
    ['aws-access-key-id', FAKE.awsAsia],
    ['google-api-key', FAKE.google],
    ['stripe', FAKE.stripeLive],
    ['stripe', FAKE.stripeRestricted],
    ['npm', FAKE.npm],
    ['telegram-bot-token', FAKE.telegram],
    ['jwt', FAKE.jwt],
  ])('%s detects its own shape in context', (name, secret) => {
    const text = `key: ${secret}\nnext line`
    expect(only(name).redact(text)).toEqual({ text: `key: ${REDACTION_MARK}\nnext line`, count: 1 })
  })

  test('the full redactor replaces each of them exactly once', () => {
    const secrets = Object.values(FAKE)
    const text = secrets.map((s, i) => `${i}) ${s}`).join('\n')
    const result = redactor.redact(text)
    expect(result.count).toBe(secrets.length)
    for (const secret of secrets) expect(result.text).not.toContain(secret)
  })

  test('a Bearer token keeps the word Bearer', () => {
    const token = `${rep('abc123', 40)}.def`
    expect(redactor.redact(`Authorization: Bearer ${token}`)).toEqual({
      text: `Authorization: Bearer ${REDACTION_MARK}`,
      count: 1,
    })
  })

  test('credentials in a URL lose only the password', () => {
    expect(redactor.redact('DATABASE_URL=postgres://app:s3cr3t-Pa55@db.local:5432/app')).toEqual({
      text: `DATABASE_URL=postgres://app:${REDACTION_MARK}@db.local:5432/app`,
      count: 1,
    })
  })

  test('a PEM private key goes as a whole block', () => {
    const body = Array.from({ length: 5 }, () => rep('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 64)).join(
      '\n',
    )
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    expect(redactor.redact(`before\n${pem}\nafter`)).toEqual({
      text: `before\n${REDACTION_MARK}\nafter`,
      count: 1,
    })
  })

  test.each([['OPENSSH '], ['EC '], ['ENCRYPTED '], ['']])('also %sPRIVATE KEY blocks', (kind) => {
    const pem = `-----BEGIN ${kind}PRIVATE KEY-----\nabc\n-----END ${kind}PRIVATE KEY-----`
    expect(redactor.redact(pem).text).toBe(REDACTION_MARK)
  })

  test('a PEM block cut off before its END line is redacted to the end', () => {
    expect(redactor.redact('key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQ...').text).toBe(
      `key:\n${REDACTION_MARK}`,
    )
  })

  test('a public key or certificate is not a secret', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
    expect(redactor.redact(cert)).toEqual({ text: cert, count: 0 })
  })
})

describe('precision: ordinary developer text passes through unchanged', () => {
  const corpus = {
    diff: [
      'diff --git a/src/main.ts b/src/main.ts',
      'index 4b89a3d1e2f..80e3ced9a7b 100644',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -40,7 +40,9 @@ const devPort = parseDevPort(process.env[DEV_PORT_ENV])',
      '-const noChatPlatform: ChatGateway = {',
      '+const outbound = buildOutbound({ token, dev: devReplies, literalSecrets })',
      "+  task-runner-config: 'sk-learn' // a skeleton key-value store",
      '   logger.info("channel connected", { stateDir })',
    ].join('\n'),
    stackTrace: [
      'TypeError: Cannot read properties of undefined (reading "id")',
      '    at AuthenticateSenderStep.handle (C:\\Users\\dev\\project\\src\\application\\pipeline\\AuthenticateSenderStep.ts:25:31)',
      '    at /home/dev/project/node_modules/grammy/out/composer.js:134:20',
      '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n'),
    commits: [
      '80e3ced9a7b2c41d5e6f7a8b9c0d1e2f3a4b5c6d feat: bot setup, pairing and sender allowlist (F1) (#2)',
      '4b89a3d chore: scaffold project and minimal channel (F0) (#1)',
      '01d9ae5 Initial commit',
    ].join('\n'),
    ids: [
      'request 3f2c7a9e-4b1d-4e8a-9c2f-7d5e6b8a1c0f failed',
      'user 5000000001 at 2026-11-13T10:15:30.000Z, message 12345',
      'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'integrity sha512-Xk9+0abcDEF/ghiJKL==',
    ].join('\n'),
    prose: [
      'Set the Authorization header to "Bearer <token>" and use a bearer token from your vault.',
      'The API key lives in .env as OPENAI_API_KEY; never paste it here. Ask for sk- prefixed keys.',
      'Paths: ./src/domain, ../tests, ~/projects, /var/log/syslog, C:\\Windows\\System32.',
      'URLs: https://github.com/org/repo/pull/2 and http://localhost:3000/api?x=1#y.',
      'Ports 8080:80, ratio 16:9, time 10:15:30, and an email dev@example.com.',
      'Emoji and accents: ¡Listo! ✅ código añadido.',
    ].join('\n'),
  }

  test.each(Object.entries(corpus))('%s', (_name, text) => {
    expect(redactor.redact(text)).toEqual({ text, count: 0 })
  })
})

describe('exact values', () => {
  test('every occurrence is replaced and counted', () => {
    const detector = new ExactValueDetector(['hunter2-hunter2'])
    expect(new SecretRedactor([detector]).redact('a hunter2-hunter2 b hunter2-hunter2')).toEqual({
      text: `a ${REDACTION_MARK} b ${REDACTION_MARK}`,
      count: 2,
    })
  })

  test('the redactor uses the selected literal values', () => {
    const r = createSecretRedactor(['NODE_ENV-ish', 'production', 'Zq8!vR2#pL'])
    expect(r.redact('deploying to production with Zq8!vR2#pL')).toEqual({
      text: `deploying to production with ${REDACTION_MARK}`,
      count: 1,
    })
  })

  test('overlapping detections are merged into one redaction', () => {
    // sk-ant- keys also match the generic sk- rule; and the value is also a literal.
    const r = createSecretRedactor([FAKE.anthropic])
    expect(r.redact(`x ${FAKE.anthropic} y`)).toEqual({ text: `x ${REDACTION_MARK} y`, count: 1 })
  })
})

describe('selectSecretValues', () => {
  test('keeps values that look like secrets', () => {
    expect(
      selectSecretValues([
        'Zq8!vR2#pL',
        'aB3dE5gH7jK9',
        'postgres://app:pw@db/app',
        'correct-Horse-9',
        '  padded-S3cret  ',
      ]),
    ).toEqual([
      'Zq8!vR2#pL',
      'aB3dE5gH7jK9',
      'postgres://app:pw@db/app',
      'correct-Horse-9',
      'padded-S3cret',
    ])
  })

  test.each([
    ['short', 'abc123'],
    ['number', '1234567890'],
    ['decimal', '3.14159265'],
    ['boolean', 'TRUE'],
    ['lowercase word', 'production'],
    ['kebab words', 'my-app-name'],
    ['capitalized word', 'Development'],
    ['constant', 'LOG_LEVEL_DEBUG'],
    ['url', 'https://api.example.com/v1'],
    ['email', 'dev@example.com'],
    ['unix path', '/var/lib/app/data'],
    ['relative path', './fixtures/data'],
    ['windows path', 'C:\\Users\\dev\\app'],
    ['home path', '~/projects/app'],
  ])('drops a trivially non-secret %s', (_label, value) => {
    expect(selectSecretValues([value])).toEqual([])
  })
})

describe('PatternDetector', () => {
  test('reports the chosen capture group only', () => {
    const detector: SecretDetector = new PatternDetector('pin', /pin=(\d+)/, 1)
    expect([...detector.find('a pin=1234 b')]).toEqual([{ start: 6, end: 10 }])
  })
})
