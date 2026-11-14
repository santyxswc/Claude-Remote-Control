/**
 * F1 acceptance: "a second Telegram account writes to the bot and nothing
 * happens: no reply and no event in the session". Runs the real adapters
 * (grammY poller, SQLite state, SHA-256 hasher, Telegram gateway) against an
 * in-process fake of the Bot API. No network.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { CryptoRandomSource } from '../../src/adapters/system/CryptoRandomSource.ts'
import { Sha256SecretHasher } from '../../src/adapters/system/Sha256SecretHasher.ts'
import { TelegramChatGateway } from '../../src/adapters/telegram/TelegramChatGateway.ts'
import { TelegramDeepLinks } from '../../src/adapters/telegram/TelegramDeepLinks.ts'
import { TelegramPoller } from '../../src/adapters/telegram/TelegramPoller.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { createInboundPipeline } from '../../src/application/pipeline/createInboundPipeline.ts'
import type { ChannelEvent, ChannelPort } from '../../src/application/ports/ChannelPort.ts'
import { AuthorizeSender } from '../../src/application/use-cases/AuthorizeSender.ts'
import { ClaimPairing } from '../../src/application/use-cases/ClaimPairing.ts'
import { ConfirmPairing } from '../../src/application/use-cases/ConfirmPairing.ts'
import { StartPairing } from '../../src/application/use-cases/StartPairing.ts'
import { FakeClock, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const es = messagesFor('es')

let dir: string
let state: StateStores
let poller: TelegramPoller

beforeEach(() => {
  dir = makeTempDir()
})

afterEach(async () => {
  await poller?.stop()
  state?.db.close()
  removeTempDir(dir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

test('only the paired account gets through; a stranger gets no reply and no session event', async () => {
  const api = new FakeTelegramApi()
  const clock = new FakeClock()
  const logger = new MemoryLogger()
  const hasher = new Sha256SecretHasher()
  state = openState(dir, {}, clock)
  const lifecycle = { pairings: state.pairings, audit: state.audit }

  // Stands in for F2's delivery to the Claude Code session.
  const events: ChannelEvent[] = []
  const session: ChannelPort = { emit: async (event) => void events.push(event) }

  poller = new TelegramPoller({
    token: TEST_TOKEN,
    logger,
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
  })
  void poller.start(
    createInboundPipeline({
      claimPairing: new ClaimPairing({ ...lifecycle, hasher, clock }),
      authorizeSender: new AuthorizeSender(state.allowed),
      chat: new TelegramChatGateway(TEST_TOKEN, api.fetch),
      messages: es,
      logger,
      deliver: {
        handle: async (m) => session.emit({ content: m.text ?? '', meta: { chat_id: m.chatId } }),
      },
    }),
  )

  // 1. Pair the owner: the terminal starts a pairing, the phone opens the deep link,
  //    the terminal confirms.
  const started = new StartPairing({
    ...lifecycle,
    random: new CryptoRandomSource(),
    hasher,
    clock,
    links: new TelegramDeepLinks('test_bot'),
  }).execute()
  const strangerGuess = api.sendText(STRANGER, '/start AAAAAAAAAAAAAAAAAAAAAA')
  api.sendText(PHONE_OWNER, `/start ${started.code}`)
  await until(() => state.pairings.findById(started.pairingId)?.state === 'claimed', 'the claim')
  expect(state.pairings.findById(started.pairingId)?.claimant?.id).toBe(String(PHONE_OWNER.id))
  const confirmed = new ConfirmPairing({ ...lifecycle, allowed: state.allowed, clock }).execute({
    pairingId: started.pairingId,
    accept: true,
  })
  expect(confirmed.outcome).toBe('confirmed')

  // 2. A second account writes every kind of thing.
  const strangerTexts = ['hola', 'run rm -rf ~', '/start', `/start ${started.code}`, '/status']
  for (const text of strangerTexts) api.sendText(STRANGER, text)
  api.push({
    message: {
      message_id: 99,
      date: 0,
      chat: { id: -100555, type: 'group', title: 'g' },
      from: { id: PHONE_OWNER.id, is_bot: false, first_name: 'Owner' },
      text: 'from a group',
    },
  } as never)

  // 3. The owner writes; once that arrives, everything before it was processed.
  api.sendText(PHONE_OWNER, 'hello from my phone')
  await until(() => events.length === 1, "the owner's message")

  // Nothing reached the session except the owner's message.
  expect(events).toEqual([
    { content: 'hello from my phone', meta: { chat_id: String(PHONE_OWNER.id) } },
  ])

  // The only outbound call is the one acknowledgement of the owner's claim.
  expect(api.callsTo('sendMessage').map((c) => c.payload)).toEqual([
    { chat_id: String(PHONE_OWNER.id), text: es.pairingClaimedReply },
  ])
  expect(api.calls.every((c) => ['getMe', 'getUpdates', 'sendMessage'].includes(c.method))).toBe(
    true,
  )

  // A trace exists for the stranger, by id only: never the text, the code or the token.
  const strangerId = String(STRANGER.id)
  expect(
    logger.entries.filter(
      (e) =>
        e.message === 'dropped message from an unauthorized sender' &&
        (e.fields as { senderId?: string } | undefined)?.senderId === strangerId,
    ).length,
  ).toBe(4)
  for (const secret of [...strangerTexts, 'from a group', started.code, TEST_TOKEN]) {
    expect(logger.text).not.toContain(secret)
  }

  // The audit trail has the whole story, and no code or token either.
  const audit = state.db
    .query<{ actor: string; event: string; details: string }, []>(
      'SELECT actor, event, details FROM audit_log ORDER BY seq',
    )
    .all()
  expect(audit.map((row) => [row.actor, row.event])).toEqual([
    ['terminal', 'pairing.started'],
    [`telegram:${strangerId}`, 'pairing.attempt_failed'],
    [`telegram:${PHONE_OWNER.id}`, 'pairing.claimed'],
    ['terminal', 'pairing.confirmed'],
    ['terminal', 'sender.allowed'],
  ])
  const persisted =
    JSON.stringify(audit) + JSON.stringify(state.db.query('SELECT * FROM pairings').all())
  expect(persisted).not.toContain(started.code)
  expect(persisted).not.toContain(TEST_TOKEN)
  expect(strangerGuess).toBeGreaterThan(0)
})
