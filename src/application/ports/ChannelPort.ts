/**
 * Routing attributes attached to an inbound event. Each entry becomes an
 * attribute of the `<channel>` tag Claude sees, so keys must be identifiers.
 */
export type ChannelMeta = Readonly<Record<string, string>>

/** An inbound chat event to deliver to the running Claude Code session. */
export interface ChannelEvent {
  readonly content: string
  readonly meta?: ChannelMeta
}

/** Delivers inbound chat events to the session. */
export interface ChannelPort {
  /**
   * Resolves once the event is handed to the session transport. It does not
   * mean Claude has read or processed it.
   */
  emit(event: ChannelEvent): Promise<void>
}
