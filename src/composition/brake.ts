/**
 * Wires F6: the brake use cases over the state directory's flag file, the
 * permission relay (for the denials) and the session controller.
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { SessionController } from '../application/ports/SessionController.ts'
import { EngageBrake } from '../application/use-cases/EngageBrake.ts'
import { ResumeSession } from '../application/use-cases/ResumeSession.ts'
import { StopSession } from '../application/use-cases/StopSession.ts'
import type { PermissionWiring } from './permissions.ts'

export interface BrakeWiringDeps {
  readonly state: Pick<StateStores, 'brake' | 'audit' | 'permissions'>
  readonly permissions: Pick<PermissionWiring, 'resolve' | 'session'>
  readonly controller: SessionController
  readonly clock: Clock
  readonly logger: Logger
}

export interface BrakeWiring {
  readonly stop: StopSession
  readonly resume: ResumeSession
}

export function buildBrake(deps: BrakeWiringDeps): BrakeWiring {
  const { state, clock, logger } = deps
  const common = { brake: state.brake, audit: state.audit, clock, logger }
  return {
    stop: new StopSession({
      engage: new EngageBrake(common),
      store: state.permissions,
      resolve: deps.permissions.resolve,
      controller: deps.controller,
      audit: state.audit,
      clock,
      logger,
      session: deps.permissions.session,
    }),
    resume: new ResumeSession(common),
  }
}
