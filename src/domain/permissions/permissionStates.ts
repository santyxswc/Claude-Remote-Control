/**
 * GoF State for `PermissionRequest`: one object per state, each allowing only
 * its own transitions. Anything not overridden is an invalid transition.
 */
import { DomainError } from '../DomainError.ts'
import type { SenderId } from '../Sender.ts'
import type { PermissionSnapshot, PermissionState } from './PermissionRequest.ts'

/** A high-risk approval must be confirmed with a second tap within this window. */
export const CONFIRMATION_WINDOW_MS = 30_000

export class InvalidPermissionTransitionError extends DomainError {
  constructor(
    readonly from: PermissionState,
    readonly action: string,
  ) {
    super(`Cannot ${action} a permission request that is ${from}`)
  }
}

type Changes = Partial<PermissionSnapshot>

abstract class StateBehavior {
  constructor(readonly name: PermissionState) {}

  approve(_data: PermissionSnapshot, _by: SenderId, _now: number): Changes {
    return this.invalid('approve')
  }

  confirm(_data: PermissionSnapshot, _by: SenderId, _now: number): Changes {
    return this.invalid('confirm')
  }

  cancel(_data: PermissionSnapshot, _now: number): Changes {
    return this.invalid('cancel')
  }

  deny(_data: PermissionSnapshot, _by: SenderId, _now: number): Changes {
    return this.invalid('deny')
  }

  expire(_data: PermissionSnapshot, _now: number): Changes {
    return this.invalid('expire')
  }

  resolveLocally(_data: PermissionSnapshot, _now: number): Changes {
    return this.invalid('resolve locally')
  }

  deliveryFailed(_data: PermissionSnapshot): Changes {
    return this.invalid('record a failed delivery for')
  }

  /** Time-driven change, if any. */
  settle(_data: PermissionSnapshot, _now: number): Changes | undefined {
    return undefined
  }

  protected invalid(action: string): never {
    throw new InvalidPermissionTransitionError(this.name, action)
  }
}

const decided = (state: 'approved' | 'denied', by: SenderId, now: number): Changes => ({
  state,
  decidedBy: by,
  decidedAt: now,
})

const closed = (state: 'expired' | 'resolved_locally', now: number): Changes => ({
  state,
  decidedAt: now,
  confirmationRequestedAt: undefined,
})

/** Shared by both open states. */
abstract class OpenState extends StateBehavior {
  override deny(_data: PermissionSnapshot, by: SenderId, now: number): Changes {
    return decided('denied', by, now)
  }

  override expire(_data: PermissionSnapshot, now: number): Changes {
    return closed('expired', now)
  }

  override resolveLocally(_data: PermissionSnapshot, now: number): Changes {
    return closed('resolved_locally', now)
  }
}

class Pending extends OpenState {
  constructor() {
    super('pending')
  }

  override approve(data: PermissionSnapshot, by: SenderId, now: number): Changes {
    if (data.risk === 'high') {
      return { state: 'awaiting_confirmation', confirmationRequestedAt: now }
    }
    return decided('approved', by, now)
  }
}

class AwaitingConfirmation extends OpenState {
  constructor() {
    super('awaiting_confirmation')
  }

  override confirm(data: PermissionSnapshot, by: SenderId, now: number): Changes {
    if (windowPassed(data, now)) return this.invalid('confirm (window passed)')
    return decided('approved', by, now)
  }

  override cancel(_data: PermissionSnapshot, _now: number): Changes {
    return { state: 'pending', confirmationRequestedAt: undefined }
  }

  override settle(data: PermissionSnapshot, now: number): Changes | undefined {
    return windowPassed(data, now)
      ? { state: 'pending', confirmationRequestedAt: undefined }
      : undefined
  }
}

/** approved or denied: final, unless the verdict never reached Claude Code. */
class Decided extends StateBehavior {
  override deliveryFailed(_data: PermissionSnapshot): Changes {
    return {
      state: 'pending',
      decidedBy: undefined,
      decidedAt: undefined,
      confirmationRequestedAt: undefined,
    }
  }
}

/** expired or resolved_locally: nothing more can happen. */
class Closed extends StateBehavior {}

function windowPassed(data: PermissionSnapshot, now: number): boolean {
  return now >= (data.confirmationRequestedAt ?? 0) + CONFIRMATION_WINDOW_MS
}

const STATES: Readonly<Record<PermissionState, StateBehavior>> = {
  pending: new Pending(),
  awaiting_confirmation: new AwaitingConfirmation(),
  approved: new Decided('approved'),
  denied: new Decided('denied'),
  resolved_locally: new Closed('resolved_locally'),
  expired: new Closed('expired'),
}

export function stateBehavior(state: PermissionState): StateBehavior {
  return STATES[state]
}
