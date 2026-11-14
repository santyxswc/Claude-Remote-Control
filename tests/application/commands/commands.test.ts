import { describe, expect, test } from 'bun:test'
import type { CommandContext } from '../../../src/application/commands/ChatCommand.ts'
import {
  CommandRegistry,
  InvalidCommandError,
} from '../../../src/application/commands/CommandRegistry.ts'
import { createCommandRegistry } from '../../../src/application/commands/createCommandRegistry.ts'
import { HelpCommand } from '../../../src/application/commands/HelpCommand.ts'
import { parseCommand } from '../../../src/application/commands/parseCommand.ts'
import { StartCommand } from '../../../src/application/commands/StartCommand.ts'
import { StatusCommand } from '../../../src/application/commands/StatusCommand.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { ResumeSession } from '../../../src/application/use-cases/ResumeSession.ts'
import type { StopSession } from '../../../src/application/use-cases/StopSession.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { ALICE, InMemoryAllowedSenders, InMemoryBrakeFlag } from '../../fakes.ts'

const en = messagesFor('en')

function context(args = ''): { ctx: CommandContext; replies: string[] } {
  const replies: string[] = []
  return {
    replies,
    ctx: { chatId: ALICE.id, sender: ALICE, args, reply: async (t) => void replies.push(t) },
  }
}

describe('parseCommand', () => {
  test.each([
    ['/help', { name: 'help', mention: undefined, args: '' }],
    ['/status@test_bot', { name: 'status', mention: 'test_bot', args: '' }],
    ['/deploy  prod  now ', { name: 'deploy', mention: undefined, args: 'prod  now' }],
    ['/Help@Test_Bot x\ny', { name: 'Help', mention: 'Test_Bot', args: 'x\ny' }],
  ])('%p', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected)
  })

  test.each([['hello'], ['/'], [' /help'], ['/help.'], ['/a-b'], ['//x'], ['path /help']])(
    '%p is not a command',
    (text) => {
      expect(parseCommand(text)).toBeUndefined()
    },
  )
})

describe('CommandRegistry', () => {
  test('finds case-insensitively and lists in registration order', () => {
    const registry = new CommandRegistry()
      .register({ name: 'b', description: 'B', execute: async () => {} })
      .register({ name: 'a', description: 'A', execute: async () => {} })
    expect(registry.find('B')?.name).toBe('b')
    expect(registry.find('zzz')).toBeUndefined()
    expect(registry.list().map((c) => c.name)).toEqual(['b', 'a'])
  })

  test('rejects duplicates and invalid names', () => {
    const registry = new CommandRegistry().register({
      name: 'x',
      description: '',
      execute: async () => {},
    })
    expect(() =>
      registry.register({ name: 'x', description: '', execute: async () => {} }),
    ).toThrow(InvalidCommandError)
    expect(() =>
      registry.register({ name: 'Has-Dash', description: '', execute: async () => {} }),
    ).toThrow(InvalidCommandError)
  })
})

describe('F2 commands', () => {
  test('/start greets', async () => {
    const { ctx, replies } = context()
    await new StartCommand(en.commandStartDescription, en.startGreeting).execute(ctx)
    expect(replies).toEqual([en.startGreeting])
  })

  test('/help lists whatever the registry holds, including commands added later', async () => {
    const registry = new CommandRegistry()
    registry.register(new HelpCommand(en.commandHelpDescription, registry, en.help))
    registry.register({ name: 'shot', description: 'take a screenshot', execute: async () => {} })
    const { ctx, replies } = context()
    await registry.find('help')?.execute(ctx)
    expect(replies[0]).toContain('/help - show this help')
    expect(replies[0]).toContain('/shot - take a screenshot')
  })

  test('/status reports only known facts', async () => {
    const allowed = new InMemoryAllowedSenders()
    allowed.add(allowSender(ALICE, Date.UTC(2026, 10, 13, 9, 30)))
    let connected = true
    const status = new StatusCommand({
      description: en.commandStatusDescription,
      render: en.status,
      botUsername: 'test_bot',
      allowed,
      isSessionConnected: () => connected,
      pendingPermissions: () => 2,
      brake: new InMemoryBrakeFlag(),
    })
    const { ctx, replies } = context()
    await status.execute(ctx)
    connected = false
    await status.execute(ctx)
    expect(replies[0]).toBe(
      [
        'Bot: @test_bot',
        'Paired since: 2026-11-13T09:30:00.000Z',
        'MCP connection to Claude Code: open',
        'Pending permission requests: 2',
        'Brake: not engaged',
        'From here it cannot be known whether the session loaded this channel or whether Claude is busy.',
      ].join('\n'),
    )
    expect(replies[1]).toContain('MCP connection to Claude Code: closed')
  })

  test('/status without a cached identity or pairing says unknown', async () => {
    const status = new StatusCommand({
      description: '',
      render: en.status,
      botUsername: undefined,
      allowed: new InMemoryAllowedSenders(),
      isSessionConnected: () => true,
      pendingPermissions: () => 0,
      brake: new InMemoryBrakeFlag(),
    })
    const { ctx, replies } = context()
    await status.execute(ctx)
    expect(replies[0]).toContain('Bot: unknown')
    expect(replies[0]).toContain('Paired since: unknown')
  })

  test('/status shows the brake and since when; an unreadable flag is still engaged', async () => {
    const brake = new InMemoryBrakeFlag()
    const status = new StatusCommand({
      description: '',
      render: en.status,
      botUsername: undefined,
      allowed: new InMemoryAllowedSenders(),
      isSessionConnected: () => true,
      pendingPermissions: () => 0,
      brake,
    })
    const { ctx, replies } = context()
    brake.engage({ engagedAt: Date.UTC(2026, 10, 14, 8), actor: 'terminal', reason: undefined })
    await status.execute(ctx)
    brake.unreadable = true
    await status.execute(ctx)
    expect(replies[0]).toContain(
      'Brake: ENGAGED since 2026-11-14T08:00:00.000Z (/resume releases it)',
    )
    expect(replies[1]).toContain('Brake: ENGAGED since unknown')
  })
})

describe('createCommandRegistry', () => {
  test('start, help, status, stop and resume, described in the locale', () => {
    const es = messagesFor('es')
    const registry = createCommandRegistry({
      messages: es,
      botUsername: 'b',
      allowed: new InMemoryAllowedSenders(),
      isSessionConnected: () => true,
      pendingPermissions: () => 0,
      brake: new InMemoryBrakeFlag(),
      stopSession: {} as StopSession,
      resumeSession: {} as ResumeSession,
    })
    expect(registry.list().map((c) => [c.name, c.description])).toEqual([
      ['start', es.commandStartDescription],
      ['help', es.commandHelpDescription],
      ['status', es.commandStatusDescription],
      ['stop', es.commandStopDescription],
      ['resume', es.commandResumeDescription],
    ])
  })
})
