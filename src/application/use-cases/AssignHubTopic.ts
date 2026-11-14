import { baseTopicName, uniqueTopicName } from '../../domain/hub/topicName.ts'
import type { HubRegistry } from '../hub/HubRegistry.ts'
import type { Clock } from '../ports/Clock.ts'
import type { ForumTopicGateway } from '../ports/ForumTopicGateway.ts'
import type { HubSessionStore } from '../ports/HubSessionStore.ts'
import type { HubTopic, HubTopicStore } from '../ports/HubTopicStore.ts'
import type { Logger } from '../ports/Logger.ts'

/** Ended sessions of a topic handed to its next session for cleanup, at most. */
export const MAX_ENDED_SESSIONS = 50

export interface AssignHubTopicDeps {
  /** The hub's group. */
  readonly chatId: string
  readonly topics: HubTopicStore
  readonly sessions: HubSessionStore
  readonly registry: Pick<HubRegistry, 'isTopicTaken'>
  /** The decorated gateway from `buildOutbound`. */
  readonly gateway: ForumTopicGateway
  readonly clock: Clock
  readonly logger: Logger
}

export interface AssignTopicInput {
  readonly session: string
  readonly projectKey: string
  readonly projectName: string | undefined
}

export interface AssignedTopic {
  readonly topicId: string
  readonly name: string
  /** The session had this topic before (a reconnect after a hub restart). */
  readonly reconnect: boolean
  /** Ended sessions of this topic: what they left open may be cleaned up. */
  readonly ended: readonly string[]
}

/**
 * Picks the topic of a registering session (F14). A session that comes back
 * gets its topic again. Otherwise the project's first topic that no other
 * live (or reserved) session holds is reused, so a project keeps its topic
 * from run to run; when every one is busy (two sessions in one project), a
 * new topic is created with a suffixed name. Topics are never deleted.
 */
export class AssignHubTopic {
  constructor(private readonly deps: AssignHubTopicDeps) {}

  async execute(input: AssignTopicInput): Promise<AssignedTopic> {
    const { topics, sessions, registry, clock } = this.deps
    const now = clock.now()
    const known = topics.listForProject(this.deps.chatId, input.projectKey)
    const previous = sessions.find(input.session)
    const again = known.find((topic) => topic.topicId === previous?.topicId)
    let topic: HubTopic | undefined =
      again !== undefined && !registry.isTopicTaken(again.topicId, input.session, now)
        ? again
        : undefined
    const reconnect = topic !== undefined
    topic ??= known.find(
      (candidate) => !registry.isTopicTaken(candidate.topicId, input.session, now),
    )
    topic ??= await this.#create(input, known)
    sessions.upsert(input.session, topic.topicId, now)
    const ended = sessions
      .endedFor(topic.topicId, MAX_ENDED_SESSIONS)
      .filter((session) => session !== input.session)
    return { topicId: topic.topicId, name: topic.name, reconnect, ended }
  }

  /** The topic was deleted in Telegram: same slot and name, a new thread id. */
  async recreate(topicId: string): Promise<string | undefined> {
    const topic = this.deps.topics.listAll(this.deps.chatId).find((t) => t.topicId === topicId)
    if (topic === undefined) return undefined
    const fresh = await this.deps.gateway.createTopic(this.deps.chatId, topic.name)
    this.deps.topics.replaceTopicId(this.deps.chatId, topicId, fresh)
    this.deps.logger.warn('a hub topic was gone and has been recreated', { topicId, fresh })
    return fresh
  }

  async #create(input: AssignTopicInput, known: readonly HubTopic[]): Promise<HubTopic> {
    const { chatId, topics, gateway, clock } = this.deps
    const taken = topics.listAll(chatId).map((topic) => topic.name)
    const name = uniqueTopicName(baseTopicName(input.projectName), taken)
    const topicId = await gateway.createTopic(chatId, name)
    const topic: HubTopic = {
      topicId,
      chatId,
      projectKey: input.projectKey,
      slot: Math.max(0, ...known.map((t) => t.slot)) + 1,
      name,
      createdAt: clock.now(),
    }
    topics.insert(topic)
    this.deps.logger.info('created a hub topic', { topicId, slot: topic.slot })
    return topic
  }
}
