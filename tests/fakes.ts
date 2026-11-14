import type { InboundHandler } from '../src/application/pipeline/InboundStep.ts'
import type { AllowedSenderStore } from '../src/application/ports/AllowedSenderStore.ts'
import type { AuditEntry, AuditLog } from '../src/application/ports/AuditLog.ts'
import type { ChannelEvent, ChannelPort } from '../src/application/ports/ChannelPort.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../src/application/ports/ChatGateway.ts'
import type { Clock } from '../src/application/ports/Clock.ts'
import type { InboundPoller, PollingExit } from '../src/application/ports/InboundPoller.ts'
import type { LogFields, Logger } from '../src/application/ports/Logger.ts'
import type { PairingStore } from '../src/application/ports/PairingStore.ts'
import type { PermissionStore } from '../src/application/ports/PermissionStore.ts'
import type {
  PermissionVerdictPort,
  VerdictBehavior,
} from '../src/application/ports/PermissionVerdictPort.ts'
import type {
  PollerLock,
  PollerLockHolder,
  PollerLockResult,
  PollerRole,
} from '../src/application/ports/PollerLock.ts'
import type { PromptGateway, PromptKeyboard } from '../src/application/ports/PromptGateway.ts'
import type { RandomSource } from '../src/application/ports/RandomSource.ts'
import type { SecretHasher } from '../src/application/ports/SecretHasher.ts'
import type { ActivityState, SessionActivity } from '../src/application/ports/SessionActivity.ts'
import type { Sleeper } from '../src/application/ports/Sleeper.ts'
import type { Terminal } from '../src/application/ports/Terminal.ts'
import type { AllowedSender } from '../src/domain/AllowedSender.ts'
import type { Pairing } from '../src/domain/Pairing.ts'
import type { PermissionRequest, PromptRef } from '../src/domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../src/domain/Sender.ts'

export class FakeChatGateway implements ChatGateway {
  readonly sent: { chatId: string; text: string; options?: SendOptions }[] = []
  readonly typing: string[] = []
  failWith: Error | undefined
  /** Fail only from this send on (0-based), e.g. to break a chunked message midway. */
  failFromCall = 0
  typingFailWith: Error | undefined
  #calls = 0

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const call = this.#calls++
    if (this.failWith !== undefined && call >= this.failFromCall) throw this.failWith
    this.sent.push(options === undefined ? { chatId, text } : { chatId, text, options })
    return { parts: 1, redactions: 0 }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (this.typingFailWith !== undefined) throw this.typingFailWith
    this.typing.push(chatId)
  }
}

/** Records channel events; `failWith` makes `emit` reject. */
export class FakeChannel implements ChannelPort {
  readonly events: ChannelEvent[] = []
  failWith: Error | undefined
  isConnected = true

  async emit(event: ChannelEvent): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith
    this.events.push(event)
  }
}

export class FakeSessionActivity implements SessionActivity {
  constructor(public state: ActivityState = 'unknown') {}

  current(): ActivityState {
    return this.state
  }
}

export class MemoryLogger implements Logger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] = []

  info(message: string, fields?: LogFields): void {
    this.#push('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.#push('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.#push('error', message, fields)
  }

  /** Everything logged, serialized, for "does not contain" assertions. */
  get text(): string {
    return JSON.stringify(this.entries, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    )
  }

  #push(level: string, message: string, fields: LogFields | undefined): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields })
  }
}

export class FakeClock implements Clock {
  constructor(public current = 1_700_000_000_000) {}

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }
}

/** Advances the fake clock instead of waiting. */
export class FakeSleeper implements Sleeper {
  readonly naps: number[] = []
  onSleep: (() => void) | undefined

  constructor(private readonly clock: FakeClock) {}

  async sleep(ms: number): Promise<void> {
    this.naps.push(ms)
    this.clock.advance(ms)
    this.onSleep?.()
  }
}

/** Deterministic bytes: 0, 1, 2, ... continuing across calls. */
export class SequentialRandom implements RandomSource {
  #next = 0

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) out[i] = this.#next++ % 256
    return out
  }
}

/** Reversible stand-in so tests can see what was hashed; never used outside tests. */
export class FakeHasher implements SecretHasher {
  hash(secret: string): string {
    return `hash(${secret})`
  }

  matches(secret: string, hash: string): boolean {
    return this.hash(secret) === hash
  }
}

export class InMemoryPairingStore implements PairingStore {
  readonly #rows = new Map<string, Pairing>()
  #order: string[] = []

  insert(pairing: Pairing): void {
    if (this.#rows.has(pairing.id)) throw new Error(`duplicate pairing ${pairing.id}`)
    this.#rows.set(pairing.id, pairing)
    this.#order.push(pairing.id)
  }

  update(next: Pairing): boolean {
    const current = this.#rows.get(next.id)
    if (current === undefined || current.revision !== next.revision - 1) return false
    this.#rows.set(next.id, next)
    return true
  }

  findById(id: string): Pairing | undefined {
    return this.#rows.get(id)
  }

  findActive(): Pairing | undefined {
    for (const id of [...this.#order].reverse()) {
      const pairing = this.#rows.get(id)
      if (pairing?.isActive) return pairing
    }
    return undefined
  }

  all(): Pairing[] {
    return this.#order.map((id) => this.#rows.get(id)).filter((p) => p !== undefined)
  }
}

export class InMemoryAllowedSenders implements AllowedSenderStore {
  readonly #rows = new Map<string, AllowedSender>()

  add(sender: AllowedSender): void {
    const existing = this.#rows.get(sender.id)
    this.#rows.set(
      sender.id,
      existing === undefined ? sender : { ...sender, addedAt: existing.addedAt },
    )
  }

  remove(id: string): boolean {
    return this.#rows.delete(id)
  }

  has(id: string): boolean {
    return this.#rows.has(id)
  }

  list(): readonly AllowedSender[] {
    return [...this.#rows.values()]
  }
}

export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = []

  append(entry: AuditEntry): void {
    this.entries.push(entry)
  }

  get events(): string[] {
    return this.entries.map((entry) => entry.event)
  }
}

export class FakeLock implements PollerLock {
  holder: PollerLockHolder | undefined
  held = false
  refreshResult = true
  readonly calls: string[] = []

  tryAcquire(role: PollerRole): PollerLockResult {
    this.calls.push(`acquire:${role}`)
    if (this.holder !== undefined) return { acquired: false, holder: this.holder }
    this.held = true
    return { acquired: true }
  }

  refresh(): boolean {
    this.calls.push('refresh')
    return this.held && this.refreshResult
  }

  release(): void {
    this.calls.push('release')
    this.held = false
  }
}

/** A poller driven by the test: `deliver` plays an inbound message, `end` a fatal exit. */
export class FakePoller implements InboundPoller {
  handler: InboundHandler | undefined
  starts = 0
  stops = 0
  #finish: ((exit: PollingExit) => void) | undefined

  start(handler: InboundHandler): Promise<PollingExit> {
    this.starts += 1
    this.handler = handler
    return new Promise((resolve) => {
      this.#finish = resolve
    })
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.#end('stopped')
  }

  end(exit: PollingExit): void {
    this.#end(exit)
  }

  async deliver(...args: Parameters<InboundHandler>): Promise<void> {
    if (this.handler === undefined) throw new Error('not polling')
    await this.handler(...args)
  }

  get running(): boolean {
    return this.#finish !== undefined
  }

  #end(exit: PollingExit): void {
    const finish = this.#finish
    this.#finish = undefined
    this.handler = undefined
    finish?.(exit)
  }
}

/** Scripted terminal: queued answers, captured output. */
export class FakeTerminal implements Terminal {
  readonly out: string[] = []
  readonly err: string[] = []
  readonly prompts: string[] = []
  answers: string[] = []
  confirmations: boolean[] = []
  secret: string | Error = ''
  piped: string | Error = ''
  onConfirm: (() => void) | undefined

  print(line: string): void {
    this.out.push(line)
  }

  error(line: string): void {
    this.err.push(line)
  }

  async ask(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return this.answers.shift() ?? ''
  }

  async askSecret(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    if (this.secret instanceof Error) throw this.secret
    return this.secret
  }

  async confirm(prompt: string): Promise<boolean> {
    this.prompts.push(prompt)
    this.onConfirm?.()
    return this.confirmations.shift() ?? false
  }

  async readPipedInput(): Promise<string> {
    if (this.piped instanceof Error) throw this.piped
    return this.piped
  }

  /** stdout and stderr together, for "never printed" assertions. */
  get text(): string {
    return [...this.out, ...this.err].join('\n')
  }
}

/** Manual scheduler for `Every`: tests fire ticks explicitly. */
export class ManualEvery {
  readonly tasks = new Map<number, { ms: number; task: () => void }>()
  #nextId = 0

  readonly every = (ms: number, task: () => void): (() => void) => {
    const id = this.#nextId++
    this.tasks.set(id, { ms, task })
    return () => this.tasks.delete(id)
  }

  /** Runs every scheduled task with this interval once. */
  tick(ms: number): void {
    for (const { ms: interval, task } of [...this.tasks.values()]) {
      if (interval === ms) task()
    }
  }

  intervals(): number[] {
    return [...this.tasks.values()].map((t) => t.ms)
  }
}

export const ALICE: SenderProfile = { id: '111111111', username: 'alice', displayName: 'Alice A' }

/** An id above 2^53 would lose precision as a JS number; it must survive as a string. */
export const MALLORY: SenderProfile = {
  id: '9007199254740993',
  username: 'mallory',
  displayName: 'Mallory',
}

export class InMemoryPermissionStore implements PermissionStore {
  readonly #rows = new Map<string, PermissionRequest>()

  put(request: PermissionRequest): void {
    this.#rows.delete(request.id)
    this.#rows.set(request.id, request)
  }

  update(next: PermissionRequest, expectedRevision: number): boolean {
    if (this.#rows.get(next.id)?.revision !== expectedRevision) return false
    this.#rows.set(next.id, next)
    return true
  }

  findById(id: string): PermissionRequest | undefined {
    return this.#rows.get(id)
  }

  listOpen(): readonly PermissionRequest[] {
    return [...this.#rows.values()]
      .filter((request) => request.isOpen)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

/** Records prompts, edits and answers; message ids count up from 500 per chat. */
export class FakePromptGateway implements PromptGateway {
  readonly sent: { chatId: string; text: string; keyboard: PromptKeyboard }[] = []
  readonly edits: { ref: PromptRef; text: string; keyboard: PromptKeyboard }[] = []
  readonly answers: { callbackId: string; text?: string }[] = []
  failSendFor = new Set<string>()
  onSend: (() => void) | undefined
  #nextId = 500

  async sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    if (this.failSendFor.has(chatId)) throw new Error('chat unreachable')
    this.sent.push({ chatId, text, keyboard })
    this.onSend?.()
    return { chatId, messageId: String(this.#nextId++) }
  }

  async editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    this.edits.push({ ref, text, keyboard })
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.answers.push(text === undefined ? { callbackId } : { callbackId, text })
  }
}

export class FakeVerdicts implements PermissionVerdictPort {
  readonly sent: { requestId: string; behavior: VerdictBehavior }[] = []
  failWith: Error | undefined

  async sendVerdict(requestId: string, behavior: VerdictBehavior): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith
    this.sent.push({ requestId, behavior })
  }
}

export const BOB: SenderProfile = { id: '222222222', username: undefined, displayName: 'Bob B' }
