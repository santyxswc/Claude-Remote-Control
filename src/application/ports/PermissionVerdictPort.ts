export type VerdictBehavior = 'allow' | 'deny'

/** Sends a permission verdict back to the Claude Code session that asked. */
export interface PermissionVerdictPort {
  /**
   * Resolves once the verdict is handed to the session transport; rejects
   * when it cannot be (e.g. the connection is closed).
   */
  sendVerdict(requestId: string, behavior: VerdictBehavior): Promise<void>
}
