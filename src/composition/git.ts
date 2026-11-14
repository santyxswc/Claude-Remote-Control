/**
 * Wires F8: `/diff` over the read-only git adapter, the `/status` git line,
 * and the `/diff` buttons, whose instructions go through the inbound chain.
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import { gitStatusLine } from '../application/git/diffPresentation.ts'
import type { GitStatusLineView, Messages } from '../application/i18n/messages.ts'
import type { InboundHandler } from '../application/pipeline/InboundStep.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { DocumentGateway } from '../application/ports/DocumentGateway.ts'
import type { GitRepository } from '../application/ports/GitRepository.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import { AuthorizeReplyTarget } from '../application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { RequestGitAction } from '../application/use-cases/RequestGitAction.ts'
import { ShowDiff } from '../application/use-cases/ShowDiff.ts'

export interface GitWiringDeps {
  readonly git: GitRepository
  readonly state: Pick<StateStores, 'allowed' | 'audit' | 'brake'>
  /** The decorated gateway from `buildOutbound`. */
  readonly outbound: DocumentGateway & PromptGateway
  readonly project: string | undefined
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
}

export interface GitWiring {
  readonly diff: ShowDiff
  readonly statusLine: () => Promise<GitStatusLineView | undefined>
  /** The button taps; `deliver` is the inbound chain, so an instruction is typed text. */
  actions(deliver: InboundHandler): RequestGitAction
}

export function buildGit(deps: GitWiringDeps): GitWiring {
  const { git, state, messages, clock, logger } = deps
  return {
    diff: new ShowDiff({
      git,
      documents: deps.outbound,
      prompts: deps.outbound,
      // Documents only go to the private chat of an allowlisted sender.
      target: new AuthorizeReplyTarget(new AuthorizeSender(state.allowed)),
      project: deps.project,
      messages,
      audit: state.audit,
      clock,
      logger,
    }),
    statusLine: async () => {
      const read = await git.read({ withChanges: false })
      if (read.kind === 'not_a_repo') return { kind: 'not_a_repo' }
      return read.kind === 'ok' ? gitStatusLine(read.status) : undefined
    },
    actions: (deliver) =>
      new RequestGitAction({
        deliver,
        prompts: deps.outbound,
        brake: state.brake,
        messages,
        audit: state.audit,
        clock,
        logger,
      }),
  }
}
