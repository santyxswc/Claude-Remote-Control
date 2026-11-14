import { topicTarget } from '../../domain/hub/conversationTarget.ts'
import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import { TopicGoneError } from '../ports/ForumTopicGateway.ts'
import type { HubSessionStore } from '../ports/HubSessionStore.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AssignedTopic, AssignHubTopic } from '../use-cases/AssignHubTopic.ts'
import { type HubRegistry, LiveSession, type SpokeChannel } from './HubRegistry.ts'

/** After a hub restart, how long a session that was open keeps its topic waiting for it. */
export const RESERVATION_MS = 60_000

export interface HubSessionLifecycleDeps {
  /** The hub's group. */
  readonly chatId: string
  readonly registry: HubRegistry
  readonly sessions: HubSessionStore
  readonly assign: Pick<AssignHubTopic, 'execute' | 'recreate'>
  /** The hub's decorated gateway. */
  readonly chat: ChatGateway
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
}

export interface RegisterSpokeInput {
  readonly session: string
  readonly projectKey: string
  readonly projectName: string | undefined
  readonly channel: SpokeChannel
}

export type RegisterSpokeResult =
  | { readonly ok: true; readonly live: LiveSession; readonly assigned: AssignedTopic }
  | { readonly ok: false }

/**
 * Spokes coming and going (F14). Registrations run one at a time, so two
 * sessions of one project starting together never get the same topic. A
 * connection is bound to its topic for its whole life; when it closes, the
 * session is marked ended and only its own topic is told.
 */
export class HubSessionLifecycle {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: HubSessionLifecycleDeps) {}

  register(input: RegisterSpokeInput): Promise<RegisterSpokeResult> {
    const run = this.#queue.then(() => this.#register(input))
    this.#queue = run.catch(() => {})
    return run
  }

  /** The connection closed: the session ended (or will reconnect, after a hub restart only). */
  async end(live: LiveSession, announce: boolean): Promise<void> {
    if (!this.deps.registry.remove(live)) return
    this.deps.sessions.markEnded(live.session, this.deps.clock.now())
    this.deps.logger.info('a session left the hub', { topicId: live.topicId })
    if (announce) await this.#post(live, this.deps.messages.hubSessionEnded, false)
  }

  /** The hub itself is going away: the session lives on and will reconnect to the next hub. */
  detach(live: LiveSession): void {
    this.deps.registry.remove(live)
  }

  /** At hub start: sessions that were open keep their topics for a while. */
  reserveOpenSessions(): void {
    const until = this.deps.clock.now() + RESERVATION_MS
    for (const open of this.deps.sessions.listOpen()) {
      this.deps.registry.reserve(open.topicId, open.session, until)
    }
  }

  /** Sessions whose reservation ran out never came back: they ended. */
  sweepReservations(): void {
    const now = this.deps.clock.now()
    for (const session of this.deps.registry.expiredReservations(now)) {
      if (this.deps.registry.bySession(session) === undefined) {
        this.deps.sessions.markEnded(session, now)
      }
    }
  }

  async #register(input: RegisterSpokeInput): Promise<RegisterSpokeResult> {
    const { registry, logger } = this.deps
    const stale = registry.bySession(input.session)
    if (stale !== undefined) {
      // The same session again: its earlier connection is dead and just not noticed yet.
      registry.remove(stale)
      stale.channel.close()
    }
    let assigned: AssignedTopic
    try {
      assigned = await this.deps.assign.execute(input)
    } catch (error) {
      logger.error('could not assign a topic to a session', { error })
      return { ok: false }
    }
    const live = new LiveSession(
      input.session,
      assigned.topicId,
      assigned.name,
      input.projectKey,
      input.projectName,
      input.channel,
    )
    registry.add(live)
    logger.info('a session joined the hub', {
      topicId: live.topicId,
      reconnect: assigned.reconnect,
    })
    if (!assigned.reconnect) {
      await this.#post(live, this.deps.messages.hubSessionStarted(input.projectName))
    }
    return { ok: true, live, assigned }
  }

  /** Best effort; a deleted topic is recreated once, here, before the session uses it. */
  async #post(live: LiveSession, text: string, recreate = true): Promise<void> {
    const send = () => this.deps.chat.sendText(topicTarget(this.deps.chatId, live.topicId), text)
    try {
      await send()
    } catch (error) {
      if (!(error instanceof TopicGoneError) || !recreate) {
        this.deps.logger.warn('the hub could not post in a topic', { error })
        return
      }
      try {
        const fresh = await this.deps.assign.recreate(live.topicId)
        if (fresh === undefined) return
        live.topicId = fresh
        this.deps.sessions.upsert(live.session, fresh, this.deps.clock.now())
        await send()
      } catch (again) {
        this.deps.logger.warn('the hub could not recreate a topic', { error: again })
      }
    }
  }
}
