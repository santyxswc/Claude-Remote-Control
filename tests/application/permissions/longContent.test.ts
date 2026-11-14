import { describe, expect, test } from 'bun:test'
import { ChunkingChatGateway } from '../../../src/application/outbound/ChunkingChatGateway.ts'
import { RedactingChatGateway } from '../../../src/application/outbound/RedactingChatGateway.ts'
import { RedactingPromptGateway } from '../../../src/application/outbound/RedactingPromptGateway.ts'
import type {
  ChatGateway,
  SendOptions,
  SendReceipt,
} from '../../../src/application/ports/ChatGateway.ts'
import type { PromptGateway, PromptKeyboard } from '../../../src/application/ports/PromptGateway.ts'
import { NotifySessionEvent } from '../../../src/application/use-cases/NotifySessionEvent.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { NoticePolicy } from '../../../src/domain/notices/NoticePolicy.ts'
import type { PromptRef } from '../../../src/domain/permissions/PermissionRequest.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  ALICE,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MemoryLogger,
} from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

const MAX = 4096
/** A `.env` value (matched exactly) and a shape-detected token. */
const LITERAL = 'Zq8!vR2#pL9mW4xT7nB3'
const TOKEN = `ghp_${'K'.repeat(36)}`

/** The platform behind the decorators: records every message in order. */
class Platform implements ChatGateway, PromptGateway {
  readonly log: { kind: 'text' | 'prompt' | 'edit'; text: string }[] = []
  failText = false
  #id = 1

  async sendText(_chatId: string, text: string, _options?: SendOptions): Promise<SendReceipt> {
    if (this.failText) throw new Error('flood wait')
    expect(text.length).toBeLessThanOrEqual(MAX)
    this.log.push({ kind: 'text', text })
    return { parts: 1, redactions: 0 }
  }
  async sendTyping(): Promise<void> {}
  async sendPrompt(chatId: string, text: string, _keyboard: PromptKeyboard): Promise<PromptRef> {
    expect(text.length).toBeLessThanOrEqual(MAX)
    this.log.push({ kind: 'prompt', text })
    return { chatId, messageId: String(this.#id++) }
  }
  async editPrompt(_ref: PromptRef, text: string): Promise<void> {
    expect(text.length).toBeLessThanOrEqual(MAX)
    this.log.push({ kind: 'edit', text })
  }
  async answerCallback(): Promise<void> {}
  get all(): string {
    return this.log.map((entry) => entry.text).join('\n')
  }
}

function wired() {
  const platform = new Platform()
  const redactor = createSecretRedactor([LITERAL])
  const harness = permissionHarness({
    prompts: new RedactingPromptGateway(platform, redactor, MAX),
    chat: new RedactingChatGateway(new ChunkingChatGateway(platform, MAX), redactor),
  })
  return { platform, ...harness }
}

/** No piece of either secret survives, whole or cut. */
function expectNoSecretFragment(text: string): void {
  expect(text).not.toContain('ghp_')
  expect(text).not.toContain('KKKK')
  for (let i = 0; i + 4 <= LITERAL.length; i++) expect(text).not.toContain(LITERAL.slice(i, i + 4))
}

describe('M2: a prompt that does not fit is never cut silently', () => {
  // The auditor's probes: the dangerous middle of a long command, and a long description.
  const pad = 'x'.repeat(1650)
  const longCommand = `{"command":"echo ${pad} ; python3 -c 'import shutil; shutil.rmtree(\\"/home/me\\")' ; echo ${pad}","description":"Print a banner"}`

  test('the full input goes first as plain messages, then the buttons say it is above', async () => {
    const h = wired()
    const description = 'Print the build banner. '.repeat(25)
    expect(await h.relay.execute(incoming({ description, inputPreview: longCommand }))).toBe(
      'relayed',
    )

    const kinds = h.platform.log.map((entry) => entry.kind)
    expect(kinds.at(-1)).toBe('prompt')
    expect(kinds.slice(0, -1).every((kind) => kind === 'text')).toBe(true)
    expect(kinds.length).toBeGreaterThan(1)
    const details = h.platform.log
      .slice(0, -1)
      .map((entry) => entry.text)
      .join('')
    expect(details).toContain('shutil.rmtree')
    expect(details).toContain(longCommand.slice(-60))
    expect(details).toContain(description.trim())
    expect(details).toContain('abcde')

    const prompt = h.platform.log.at(-1)?.text ?? ''
    expect(prompt).toContain('Tool: Bash')
    expect(prompt).toContain('Request abcde')
    expect(prompt).toContain('Risk: HIGH')
    expect(prompt).toContain(en.permissionDetailsAbove)
    expect(prompt).not.toContain('…')
  })

  test('when the full input cannot be sent first: high risk, and how much is not shown', async () => {
    const h = wired()
    h.platform.failText = true
    const preview = `{"command":"echo ${'y'.repeat(5000)}"}`
    expect(await h.relay.execute(incoming({ inputPreview: preview }))).toBe('relayed')

    const prompt = h.platform.log.at(-1)
    expect(prompt?.kind).toBe('prompt')
    expect(prompt?.text).toContain('Risk: HIGH')
    const hidden = Number(/(\d+) characters not shown/.exec(prompt?.text ?? '')?.[1])
    expect(hidden).toBeGreaterThan(1000)
    expect(h.store.findById('abcde')?.risk).toBe('high')
  })

  test('a prompt that fits is one message, as before', async () => {
    const h = wired()
    await h.relay.execute(incoming())
    expect(h.platform.log.map((entry) => entry.kind)).toEqual(['prompt'])
    expect(h.platform.log[0]?.text).toContain('{"command":"ls -la"}')
  })
})

describe('M3: redaction sees the whole text before anything is cut', () => {
  test('a secret straddling any cut point of a prompt, its copies above and its edits', async () => {
    for (let offset = 0; offset < 4200; offset += 23) {
      const h = wired()
      const preview = `{"command":"${'y'.repeat(offset)} ${TOKEN} ${LITERAL}${'y'.repeat(4200 - offset)}"}`
      await h.relay.execute(incoming({ inputPreview: preview, description: `d ${LITERAL}` }))
      await h.resolve.execute({ requestId: 'abcde', action: 'deny', sender: ALICE, via: 'button' })
      h.platform.failText = true
      await h.relay.execute(incoming({ requestId: 'fghij', inputPreview: preview }))
      expect(h.platform.log.some((entry) => entry.kind === 'edit')).toBe(true)
      expectNoSecretFragment(h.platform.all)
    }
  })

  test('a secret straddling the cut point of a notice', async () => {
    for (let offset = 0; offset < 5000; offset += 17) {
      const platform = new Platform()
      const redactor = createSecretRedactor([LITERAL])
      const clock = new FakeClock()
      const allowed = new InMemoryAllowedSenders()
      allowed.add(allowSender(ALICE, clock.now()))
      const notify = new NotifySessionEvent({
        chat: new RedactingChatGateway(new ChunkingChatGateway(platform, MAX), redactor, MAX),
        allowed,
        policy: new NoticePolicy(),
        lastPermissionRelayAt: () => undefined,
        messages: en,
        audit: new InMemoryAuditLog(),
        clock,
        logger: new MemoryLogger(),
      })
      const message = `${'z'.repeat(offset)}${LITERAL} ${TOKEN} ${'z'.repeat(5000 - offset)}`
      await notify.execute({ event: 'Stop', cwd: '/p', lastMessage: message })
      expect(platform.log).toHaveLength(1)
      expectNoSecretFragment(platform.all)
    }
  })
})
