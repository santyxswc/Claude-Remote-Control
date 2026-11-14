import { join } from 'node:path'
import type {
  CallbackHandler,
  InboundCallback,
} from '../../application/callbacks/InboundCallback.ts'
import type { InboundMessage } from '../../application/pipeline/InboundMessage.ts'
import type { InboundHandler } from '../../application/pipeline/InboundStep.ts'
import type {
  HookEventSource,
  HookListenResult,
  HookPayloadHandler,
} from '../../application/ports/HookEventSource.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { hubEndpoint } from '../ipc/endpoint.ts'
import { HubClient, type HubEvent, type HubRegistration } from '../ipc/HubClient.ts'
import { readHookSecret } from '../ipc/hookSecret.ts'
import { HubAttachmentSource } from './HubAttachmentSource.ts'
import { HubChatTransport } from './HubChatTransport.ts'

/** Updates waiting in one lane at most; beyond, new ones are dropped (and logged). */
export const MAX_LANE_BACKLOG = 200

export interface SpokeHandlers {
  readonly handler: InboundHandler
  readonly callbackHandler: CallbackHandler
  /** `/stop` from the hub: deny this session's pending prompts and interrupt its turn. */
  readonly onBrake: (sender: SenderProfile) => Promise<void>
  /** Registered with the hub (again): the spoke now "polls", in its topic. */
  readonly onPollingStarted: (registration: HubRegistration) => void
  readonly onPollingStopped: () => void
}

export interface SpokeLinkOptions {
  readonly stateDir: string
  readonly session: string
  readonly projectDir: string
  readonly projectName: string | undefined
  readonly logger: Logger
  /** Test seams. */
  readonly initialRetryMs?: number
  readonly maxRetryMs?: number
}

/**
 * Everything a session's channel needs in hub mode (F14), in place of the
 * Telegram poller: the hub connection, the transport for `buildOutbound`,
 * incoming files, hook events and the inbound feed. The spoke's application
 * runs unchanged on top, with its topic seen as the owner's private chat.
 *
 * Like the poller's lanes (M1): messages run one at a time in order, taps in
 * a lane of their own, and the hub's brake at once, never queued.
 */
export class SpokeLink {
  readonly transport: HubChatTransport
  /** The hub routes this session's hook events here (F4, F9). */
  readonly hooks: HookEventSource = {
    start: async (handler: HookPayloadHandler): Promise<HookListenResult> => {
      this.#hookHandler = handler
      return 'listening'
    },
    stop: async () => {
      this.#hookHandler = undefined
    },
  }
  readonly attachments: HubAttachmentSource
  readonly #client: HubClient
  readonly #logger: Logger
  readonly #messages: Lane
  readonly #taps: Lane
  #handlers: SpokeHandlers | undefined
  #hookHandler: HookPayloadHandler | undefined
  #hookQueue: Promise<void> = Promise.resolve()
  #registration: HubRegistration | undefined

  constructor(options: SpokeLinkOptions) {
    this.#logger = options.logger
    this.#messages = new Lane('messages', options.logger)
    this.#taps = new Lane('taps', options.logger)
    this.#client = new HubClient({
      endpoint: hubEndpoint(options.stateDir),
      secret: () => readHookSecret(options.stateDir),
      session: options.session,
      projectDir: options.projectDir,
      projectName: options.projectName,
      logger: options.logger,
      onEvent: (event) => this.#onEvent(event),
      onRegistered: (registration) => {
        this.#registration = registration
        this.#handlers?.onPollingStarted(registration)
      },
      onDisconnected: () => {
        this.#registration = undefined
        this.#handlers?.onPollingStopped()
      },
      ...(options.initialRetryMs === undefined ? {} : { initialRetryMs: options.initialRetryMs }),
      ...(options.maxRetryMs === undefined ? {} : { maxRetryMs: options.maxRetryMs }),
    })
    this.transport = new HubChatTransport(this.#client)
    this.attachments = new HubAttachmentSource(this.#client, join(options.stateDir, 'tmp'))
  }

  /** Registered with the hub right now (the hub mode version of "this process polls"). */
  get isPolling(): boolean {
    return this.#registration !== undefined
  }

  /** This session's topic, once registered; scopes the pinned status store. */
  topicId(): string | undefined {
    return this.#registration?.topicId
  }

  attach(handlers: SpokeHandlers): void {
    this.#handlers = handlers
  }

  start(): void {
    this.#client.start()
  }

  async stop(): Promise<void> {
    await this.#client.stop()
    await Promise.all([this.#messages.drain(), this.#taps.drain()])
  }

  #onEvent(event: HubEvent): void {
    const handlers = this.#handlers
    if (handlers === undefined) return
    switch (event.t) {
      case 'message':
        this.#messages.push(() => handlers.handler(event.message as InboundMessage))
        return
      case 'tap':
        this.#taps.push(() => handlers.callbackHandler(event.callback as InboundCallback))
        return
      case 'brake':
        void handlers
          .onBrake(event.sender as SenderProfile)
          .catch((error: unknown) => this.#logger.error('applying the hub brake failed', { error }))
        return
      case 'hook': {
        const hook = this.#hookHandler
        if (hook === undefined) return
        this.#hookQueue = this.#hookQueue
          .then(() => hook(event.payload))
          .catch((error: unknown) => this.#logger.error('handling a hook event failed', { error }))
        return
      }
    }
  }
}

/** One ordered, bounded queue of handler runs; a failure is logged, never thrown. */
class Lane {
  #tail: Promise<void> = Promise.resolve()
  #queued = 0

  constructor(
    private readonly name: string,
    private readonly logger: Logger,
  ) {}

  push(run: () => Promise<void>): void {
    if (this.#queued >= MAX_LANE_BACKLOG) {
      this.logger.warn('dropped an update from the hub: the lane is full', { lane: this.name })
      return
    }
    this.#queued += 1
    this.#tail = this.#tail
      .then(run)
      .catch((error: unknown) => this.logger.error('inbound handler failed', { error }))
      .finally(() => {
        this.#queued -= 1
      })
  }

  drain(): Promise<void> {
    return this.#tail
  }
}
