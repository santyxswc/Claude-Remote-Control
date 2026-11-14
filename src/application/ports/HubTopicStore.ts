/** One forum topic, owned by one project directory (F14). */
export interface HubTopic {
  /** `message_thread_id`, a decimal string. */
  readonly topicId: string
  readonly chatId: string
  /** The normalized project directory (`projectKey`). */
  readonly projectKey: string
  /** 1 for the first session of a project; 2, 3... when sessions run side by side. */
  readonly slot: number
  readonly name: string
  readonly createdAt: number
}

/** Project -> topic, kept across runs so a project always gets its topic back. */
export interface HubTopicStore {
  /** Ordered by slot. */
  listForProject(chatId: string, projectKey: string): readonly HubTopic[]
  listAll(chatId: string): readonly HubTopic[]
  insert(topic: HubTopic): void
  /** The topic was deleted in Telegram and recreated under a new id. */
  replaceTopicId(chatId: string, oldTopicId: string, newTopicId: string): void
}
