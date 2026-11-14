/**
 * Wires F12: `/wrap`, `save_session_summary` and `propose_memory` with its
 * Approve/Reject taps and expiry. Proposals are scoped to this process's
 * session (like choices, ADR 0007); the files are written by the bridge
 * itself, inside the project directory.
 */
import { ClaudeMdMemoryFile } from '../adapters/project/ClaudeMdMemoryFile.ts'
import { FileSessionSummaryStore } from '../adapters/project/FileSessionSummaryStore.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import type { Messages } from '../application/i18n/messages.ts'
import { MemoryPrompts } from '../application/memory/MemoryPrompts.ts'
import type { InboundHandler } from '../application/pipeline/InboundStep.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import { AuthorizeReplyTarget } from '../application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ExpireMemoryProposals } from '../application/use-cases/ExpireMemoryProposals.ts'
import type { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'
import { ProposeMemory } from '../application/use-cases/ProposeMemory.ts'
import { RequestSessionWrap } from '../application/use-cases/RequestSessionWrap.ts'
import { ResolveMemoryProposal } from '../application/use-cases/ResolveMemoryProposal.ts'
import { SaveSessionSummary } from '../application/use-cases/SaveSessionSummary.ts'

export interface MemoryWiringDeps {
  readonly state: Pick<StateStores, 'memoryProposals' | 'allowed' | 'audit' | 'brake'>
  /** Absolute: `CLAUDE_PROJECT_DIR`, or the channel's working directory. */
  readonly projectDir: string
  /** The decorated gateway from `buildOutbound`. */
  readonly outbound: ChatGateway & PromptGateway
  /** The delivery used for typed text, so an outcome is delivered exactly like it. */
  readonly forward: HandleInboundMessage
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
  /** True while this process polls the bot (and so can receive taps). */
  readonly canAsk: () => boolean
}

export interface MemoryWiring {
  readonly propose: ProposeMemory
  readonly resolve: ResolveMemoryProposal
  readonly expire: ExpireMemoryProposals
  readonly saveSummary: SaveSessionSummary
  /** `/wrap`; `deliver` is the inbound chain, so the instruction is typed text. */
  wrap(deliver: InboundHandler): RequestSessionWrap
}

export function buildMemory(deps: MemoryWiringDeps): MemoryWiring {
  const { state, messages, clock, logger, session } = deps
  const store = state.memoryProposals
  const prompts = new MemoryPrompts(deps.outbound, messages, logger)
  const authorize = new AuthorizeSender(state.allowed)
  // Buttons and notices exist only on Telegram: no extra (dev) chats.
  const target = new AuthorizeReplyTarget(authorize)
  const common = { store, prompts, audit: state.audit, clock, logger, session }
  return {
    propose: new ProposeMemory({
      ...common,
      target,
      random: new CryptoRandomSource(),
      canAsk: deps.canAsk,
    }),
    resolve: new ResolveMemoryProposal({
      ...common,
      file: new ClaudeMdMemoryFile(deps.projectDir),
      forward: deps.forward,
      authorize,
      brake: state.brake,
      messages,
    }),
    expire: new ExpireMemoryProposals(common),
    saveSummary: new SaveSessionSummary({
      store: new FileSessionSummaryStore(deps.projectDir),
      chat: deps.outbound,
      target,
      render: (view) => messages.summarySaved(view),
      audit: state.audit,
      clock,
      logger,
    }),
    wrap: (deliver) =>
      new RequestSessionWrap({ deliver, brake: state.brake, messages, audit: state.audit, clock }),
  }
}
