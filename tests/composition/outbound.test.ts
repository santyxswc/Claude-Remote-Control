/**
 * The guarantee that no outbound text skips redaction is structural: only
 * `src/composition/outbound.ts` constructs a raw platform gateway, and it
 * exports nothing but the decorated pipeline. These tests fail if that changes.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { extractImports } from '../../scripts/architecture.ts'
import { DevChatGateway, type DevReply } from '../../src/adapters/dev/DevChatGateway.ts'
import { DEV_CHAT_ID } from '../../src/adapters/dev/DevHttpInbound.ts'
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../../src/adapters/telegram/TelegramChatGateway.ts'
import * as outboundModule from '../../src/composition/outbound.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { FakeClock, FakeSleeper } from '../fakes.ts'
import { FakeTelegramApi, TEST_TOKEN } from '../fakeTelegram.ts'
import { makePng } from '../png.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const srcRoot = join(import.meta.dir, '..', '..', 'src')

function sourceFiles(): { path: string; source: string }[] {
  return readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({
      path: relative(srcRoot, join(srcRoot, entry)).split(sep).join('/'),
      source: readFileSync(join(srcRoot, entry), 'utf8'),
    }))
}

describe('structure', () => {
  test('buildOutbound is the only runtime export of the outbound module', () => {
    expect(Object.keys(outboundModule)).toEqual(['buildOutbound'])
  })

  test('only the outbound module constructs a raw platform gateway', () => {
    const offenders = sourceFiles()
      .filter((f) => /new (TelegramChatGateway|DevChatGateway)\(/.test(f.source))
      .map((f) => f.path)
    // main.ts creates the dev gateway for its SSE subscribers and hands it to buildOutbound.
    expect(offenders.sort()).toEqual(['composition/outbound.ts', 'main.ts'])
    const main = sourceFiles().find((f) => f.path === 'main.ts')?.source ?? ''
    expect(main).not.toContain('TelegramChatGateway')
  })

  test('no module but the outbound one imports the Telegram gateway', () => {
    const importers = sourceFiles()
      .filter((f) => extractImports(f.source).some((s) => s.endsWith('/TelegramChatGateway.ts')))
      .map((f) => f.path)
    expect(importers).toEqual(['composition/outbound.ts'])
  })

  test('the dev gateway only reaches the reply path through buildOutbound in main.ts', () => {
    const main = sourceFiles().find((f) => f.path === 'main.ts')?.source ?? ''
    // devReplies may be passed to buildOutbound (as `dev:`) and to the SSE listener (as `replies:`).
    const uses = main.match(/\bdevReplies\b/g) ?? []
    const allowed =
      main.match(
        /dev: devReplies|replies: devReplies|devReplies [!=]== undefined|const devReplies/g,
      ) ?? []
    expect(uses.length).toBe(allowed.length)
  })
})

describe('behaviour', () => {
  const SECRET = 'Zq8!vR2#pL-0042'

  function setup() {
    const api = new FakeTelegramApi()
    const dev = new DevChatGateway()
    const devReplies: DevReply[] = []
    dev.subscribe((r) => devReplies.push(r))
    const chat = buildOutbound({
      token: TEST_TOKEN,
      dev,
      literalSecrets: [SECRET, 'production'],
      fetch: api.fetch,
      sleeper: new FakeSleeper(new FakeClock()),
    })
    return { api, devReplies, chat }
  }

  test('telegram gets redacted text, including the bot token itself', async () => {
    const { api, chat } = setup()
    const receipt = await chat.sendText(
      '5000000001',
      `token ${TEST_TOKEN} and ${SECRET} in production`,
    )
    expect(receipt).toEqual({ parts: 1, redactions: 2 })
    expect(api.callsTo('sendMessage')[0]?.payload.text).toBe(
      `token ${REDACTION_MARK} and ${REDACTION_MARK} in production`,
    )
  })

  test('long text is chunked to the Telegram limit, in order', async () => {
    const { api, chat } = setup()
    const paragraph = `${'word '.repeat(700).trim()}`
    const text = [paragraph, paragraph, paragraph].join('\n\n')
    const receipt = await chat.sendText('5000000001', text)
    const sent = api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
    expect(receipt.parts).toBe(sent.length)
    expect(sent.length).toBeGreaterThan(1)
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH)
    expect(sent.join('\n\n')).toBe(text)
  })

  test('the dev chat id goes to the dev listener, redacted; everything else to Telegram', async () => {
    const { api, chat, devReplies } = setup()
    await chat.sendText(DEV_CHAT_ID, `dev ${SECRET}`)
    await chat.sendTyping(DEV_CHAT_ID)
    expect(devReplies).toEqual([{ chat_id: DEV_CHAT_ID, text: `dev ${REDACTION_MARK}` }])
    expect(api.calls).toEqual([])
  })

  test('without a token only the dev chat works', async () => {
    const dev = new DevChatGateway()
    const chat = buildOutbound({ token: undefined, dev, literalSecrets: [] })
    await expect(chat.sendText(DEV_CHAT_ID, 'ok')).resolves.toEqual({ parts: 1, redactions: 0 })
    await expect(chat.sendText('5000000001', 'x')).rejects.toThrow('no chat platform is configured')
  })

  test('without a dev listener the dev chat id is just another (Telegram) chat', async () => {
    const api = new FakeTelegramApi()
    const chat = buildOutbound({
      token: TEST_TOKEN,
      dev: undefined,
      literalSecrets: [],
      fetch: api.fetch,
    })
    await chat.sendText(DEV_CHAT_ID, 'x')
    expect(api.callsTo('sendMessage')).toHaveLength(1)
  })
})

describe('prompts', () => {
  test('prompt text is redacted (including the token) and buttons reach Telegram', async () => {
    const api = new FakeTelegramApi()
    const chat = buildOutbound({
      token: TEST_TOKEN,
      dev: undefined,
      literalSecrets: ['Zq8!vR2#pL-0042'],
      fetch: api.fetch,
    })
    const ref = await chat.sendPrompt('5000000001', `rm ${TEST_TOKEN} Zq8!vR2#pL-0042`, [
      [{ label: 'OK', data: 'p1:abcde:a' }],
    ])
    await chat.editPrompt(ref, `done Zq8!vR2#pL-0042`, [])
    expect(api.callsTo('sendMessage')[0]?.payload.text).toBe(
      `rm ${REDACTION_MARK} ${REDACTION_MARK}`,
    )
    expect(api.callsTo('editMessageText')[0]?.payload.text).toBe(`done ${REDACTION_MARK}`)
    expect(JSON.stringify(api.calls)).not.toContain('Zq8!')
  })

  test('without a token there is nowhere to send a prompt', async () => {
    const chat = buildOutbound({ token: undefined, dev: new DevChatGateway(), literalSecrets: [] })
    await expect(chat.sendPrompt(DEV_CHAT_ID, 'x', [])).rejects.toThrow(
      'no chat platform is configured',
    )
  })
})

describe('images', () => {
  test('a photo and a document go up as multipart with a redacted, plain caption', async () => {
    const dir = makeTempDir()
    try {
      const path = join(dir, 'shot.png')
      const png = makePng(8, 6)
      writeFileSync(path, png)
      const api = new FakeTelegramApi()
      const chat = buildOutbound({
        token: TEST_TOKEN,
        dev: undefined,
        literalSecrets: ['Zq8!vR2#pL-0042'],
        fetch: api.fetch,
      })
      await chat.sendImage(
        '5000000001',
        { path, filename: 'screenshot.png', as: 'photo' },
        `x ${TEST_TOKEN}`,
      )
      await chat.sendImage(
        '5000000001',
        { path, filename: 'screenshot.png', as: 'document' },
        `y Zq8!vR2#pL-0042 ${'z'.repeat(2000)}`,
      )
      const [photo, document] = [api.callsTo('sendPhoto')[0], api.callsTo('sendDocument')[0]]
      expect(photo?.payload).toMatchObject({
        chat_id: '5000000001',
        caption: `x ${REDACTION_MARK}`,
      })
      expect(photo?.payload.photo).toStartWith('attach://')
      expect(photo?.payload.parse_mode).toBeUndefined()
      expect(document?.payload.document).toStartWith('attach://')
      expect(document?.payload.caption?.length).toBe(1024)
      expect(api.uploads.map((u) => [u.method, u.filename])).toEqual([
        ['sendPhoto', 'screenshot.png'],
        ['sendDocument', 'screenshot.png'],
      ])
      expect(api.uploads.every((u) => Buffer.from(u.bytes).equals(Buffer.from(png)))).toBe(true)
      expect(JSON.stringify(api.calls)).not.toContain('Zq8!')
    } finally {
      removeTempDir(dir)
    }
  })

  test('images exist only on Telegram', async () => {
    const chat = buildOutbound({ token: undefined, dev: new DevChatGateway(), literalSecrets: [] })
    await expect(
      chat.sendImage(DEV_CHAT_ID, { path: 'x.png', filename: 'x.png', as: 'photo' }, ''),
    ).rejects.toThrow('no chat platform is configured')
  })
})
