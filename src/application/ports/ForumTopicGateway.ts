/** Thrown when the topic a message was sent to no longer exists (deleted by a member). */
export class TopicGoneError extends Error {
  constructor() {
    super('the forum topic is gone')
    this.name = 'TopicGoneError'
  }
}

/**
 * Forum topics of the hub's group (F14). Like the other gateways, the
 * application only gets the decorated one from `buildOutbound`: the name is
 * redacted and fitted first.
 */
export interface ForumTopicGateway {
  /** Creates a topic and returns its thread id, as a decimal string. */
  createTopic(chatId: string, name: string): Promise<string>
}
