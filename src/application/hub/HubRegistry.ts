import { isWithinProject } from '../../domain/hub/projectKey.ts'
import { RecentSet } from '../../domain/hub/RecentSet.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { InboundCallback } from '../callbacks/InboundCallback.ts'
import type { InboundMessage } from '../pipeline/InboundMessage.ts'

/** What the hub pushes to one spoke (F14). */
export type SpokeEvent =
  | { readonly kind: 'message'; readonly message: InboundMessage }
  | { readonly kind: 'tap'; readonly callback: InboundCallback }
  | { readonly kind: 'hook'; readonly payload: unknown }
  | { readonly kind: 'brake'; readonly sender: SenderProfile }

/**
 * The hub's end of one spoke connection. `deliver` only queues: it never
 * waits for the spoke, so a slow spoke holds up nothing else. False when the
 * event could not be queued (the connection is gone or its backlog is full).
 */
export interface SpokeChannel {
  deliver(event: SpokeEvent): boolean
  close(): void
}

/** Taps and files routed to a session, remembered so its requests can be checked. */
const ROUTED_CAPACITY = 500

/** A registered spoke: one channel session, bound to one topic for its whole connection. */
export class LiveSession {
  readonly routedCallbacks = new RecentSet(ROUTED_CAPACITY)
  readonly routedFiles = new RecentSet(ROUTED_CAPACITY)
  /** Claude Code session ids whose hook events were routed here. */
  readonly claudeSessions = new RecentSet(16)

  constructor(
    readonly session: string,
    public topicId: string,
    readonly topicName: string,
    readonly projectKey: string,
    readonly projectName: string | undefined,
    readonly channel: SpokeChannel,
  ) {}
}

/**
 * The live sessions of the hub, by session id and by topic. In memory only:
 * a connection is the proof that a session is alive. A topic holds at most
 * one live session; after a hub restart the sessions that were open get
 * their topics reserved for a while, so a reconnecting session finds its
 * topic free.
 */
export class HubRegistry {
  readonly #bySession = new Map<string, LiveSession>()
  readonly #reserved = new Map<string, { readonly session: string; readonly until: number }>()

  add(live: LiveSession): void {
    this.#bySession.set(live.session, live)
    this.#reserved.delete(live.topicId)
  }

  /** Removes `live` if it is still the registered connection of its session. */
  remove(live: LiveSession): boolean {
    if (this.#bySession.get(live.session) !== live) return false
    this.#bySession.delete(live.session)
    return true
  }

  bySession(session: string): LiveSession | undefined {
    return this.#bySession.get(session)
  }

  byTopic(topicId: string): LiveSession | undefined {
    for (const live of this.#bySession.values()) if (live.topicId === topicId) return live
    return undefined
  }

  all(): readonly LiveSession[] {
    return [...this.#bySession.values()]
  }

  reserve(topicId: string, session: string, until: number): void {
    this.#reserved.set(topicId, { session, until })
  }

  /** Reservations that ran out: their sessions never came back. */
  expiredReservations(now: number): readonly string[] {
    const sessions: string[] = []
    for (const [topicId, reservation] of this.#reserved) {
      if (reservation.until > now) continue
      this.#reserved.delete(topicId)
      sessions.push(reservation.session)
    }
    return sessions
  }

  /** Someone else holds the topic: a live session, or a reservation for another session. */
  isTopicTaken(topicId: string, bySession: string, now: number): boolean {
    const live = this.byTopic(topicId)
    if (live !== undefined && live.session !== bySession) return true
    const reservation = this.#reserved.get(topicId)
    return reservation !== undefined && reservation.until > now && reservation.session !== bySession
  }

  /**
   * Which session a hook event belongs to (F4/F9 in hub mode). Hook events
   * carry Claude Code's session id and working directory; the spoke knows
   * its project directory. A Claude session already routed keeps its spoke.
   * Otherwise the spokes whose project contains `cwd`: exactly one wins; with
   * several, the only one not yet bound to a Claude session wins. Anything
   * still ambiguous goes nowhere: a notice in the wrong topic would be a
   * crossed message.
   */
  routeHook(cwd: string | undefined, claudeSession: string | undefined): LiveSession | undefined {
    const all = this.all()
    if (claudeSession !== undefined) {
      const bound = all.find((live) => live.claudeSessions.has(claudeSession))
      if (bound !== undefined) return bound
    }
    if (cwd === undefined) return undefined
    const candidates = all.filter((live) => isWithinProject(live.projectKey, cwd))
    // The deepest project wins over a parent project that also contains cwd.
    const deepest = Math.max(0, ...candidates.map((live) => live.projectKey.length))
    const inProject = candidates.filter((live) => live.projectKey.length === deepest)
    const pick =
      inProject.length === 1
        ? inProject[0]
        : claudeSession === undefined
          ? undefined
          : onlyOne(inProject.filter((live) => live.claudeSessions.size === 0))
    if (pick !== undefined && claudeSession !== undefined) pick.claudeSessions.add(claudeSession)
    return pick
  }
}

function onlyOne<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined
}
