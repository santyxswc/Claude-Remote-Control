import { expect, test } from 'bun:test'
import { BotUnreachableError, InvalidBotTokenError } from '../../../src/application/errors.ts'
import type { BotIdentityProbe } from '../../../src/application/ports/BotIdentityProbe.ts'
import { InitBot } from '../../../src/application/use-cases/InitBot.ts'
import type { BotIdentity } from '../../../src/domain/BotIdentity.ts'
import { FakeClock, InMemoryAuditLog } from '../../fakes.ts'

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup(probe: BotIdentityProbe) {
  const saved: { token?: string; identity?: BotIdentity } = {}
  const audit = new InMemoryAuditLog()
  const init = new InitBot({
    probe,
    tokens: { load: () => saved.token, save: (token) => (saved.token = token) },
    identities: { load: () => saved.identity, save: (identity) => (saved.identity = identity) },
    audit,
    clock: new FakeClock(),
  })
  return { init, saved, audit }
}

test('validates, then saves the token and identity and audits without the token', async () => {
  const { init, saved, audit } = setup({ probe: async () => ({ id: '42', username: 'my_bot' }) })

  expect(await init.execute(TOKEN)).toEqual({ id: '42', username: 'my_bot' })
  expect(saved).toEqual({ token: TOKEN, identity: { id: '42', username: 'my_bot' } })
  expect(audit.events).toEqual(['bot.initialized'])
  expect(JSON.stringify(audit.entries)).not.toContain(TOKEN)
  expect(JSON.stringify(audit.entries)).not.toContain('AAAAAAAAAA')
})

test.each([[new InvalidBotTokenError()], [new BotUnreachableError('offline')]])(
  'a failed probe (%p) saves nothing',
  async (failure) => {
    const { init, saved, audit } = setup({
      probe: async () => {
        throw failure
      },
    })
    await expect(init.execute(TOKEN)).rejects.toBe(failure)
    expect(saved).toEqual({})
    expect(audit.entries).toEqual([])
  },
)
