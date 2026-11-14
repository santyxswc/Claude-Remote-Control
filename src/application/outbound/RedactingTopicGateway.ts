import { elideMiddle } from '../../domain/elideMiddle.ts'
import { MAX_TOPIC_NAME_LENGTH } from '../../domain/hub/topicName.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { ForumTopicGateway } from '../ports/ForumTopicGateway.ts'

/** A topic name is visible to the group: secrets are replaced, then it is fitted (F14). */
export class RedactingTopicGateway implements ForumTopicGateway {
  constructor(
    private readonly inner: ForumTopicGateway,
    private readonly redactor: SecretRedactor,
  ) {}

  createTopic(chatId: string, name: string): Promise<string> {
    const redacted = this.redactor.redact(name).text
    return this.inner.createTopic(chatId, elideMiddle(redacted, MAX_TOPIC_NAME_LENGTH))
  }
}
