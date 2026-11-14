/** The forum supergroup the hub serves (F14), bound once with `hub init`. */
export interface HubGroup {
  /** The supergroup's chat id, a negative decimal string. */
  readonly chatId: string
  readonly title: string
  /** `telegram:<id>` of the allowlisted owner who sent the binding code. */
  readonly boundBy: string
  readonly boundAt: number
}

/** Hub mode is on exactly while a group is stored here. */
export interface HubGroupStore {
  load(): HubGroup | undefined
  save(group: HubGroup): void
  /** False when no group was bound. */
  clear(): boolean
}
