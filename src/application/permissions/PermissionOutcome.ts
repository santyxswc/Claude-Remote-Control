/** What a tap or a text verdict did; each one maps to a short message for the sender. */
export type PermissionOutcome =
  /** The verdict was sent to Claude Code. */
  | 'approved'
  | 'denied'
  /** High risk: the first approval now waits for Confirm. */
  | 'confirmation_requested'
  | 'confirmation_cancelled'
  /** Confirm came after the window; the request is pending again. */
  | 'confirmation_expired'
  /** High risk cannot be approved by text. */
  | 'use_button'
  | 'already_resolved'
  | 'expired'
  /** Unknown id, or one relayed by another session. */
  | 'not_found'
  /** The sender is not (or no longer) allowlisted. */
  | 'not_allowed'
  /** The action does not apply to the current state (e.g. confirm before approve). */
  | 'invalid'
  /** The verdict could not be handed to Claude Code; nothing was decided. */
  | 'delivery_failed'
  /** The panic brake is engaged: approvals are refused until `/resume`. */
  | 'braked'
