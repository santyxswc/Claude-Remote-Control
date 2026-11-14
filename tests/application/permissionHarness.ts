import { messagesFor } from '../../src/application/i18n/messages.ts'
import { PermissionPrompts } from '../../src/application/permissions/PermissionPrompts.ts'
import type { ChatGateway } from '../../src/application/ports/ChatGateway.ts'
import type { PromptGateway } from '../../src/application/ports/PromptGateway.ts'
import { AuthorizeSender } from '../../src/application/use-cases/AuthorizeSender.ts'
import { ExpirePermissions } from '../../src/application/use-cases/ExpirePermissions.ts'
import { MarkPermissionResolvedLocally } from '../../src/application/use-cases/MarkPermissionResolvedLocally.ts'
import {
  type IncomingPermissionRequest,
  RelayPermissionRequest,
} from '../../src/application/use-cases/RelayPermissionRequest.ts'
import { ResolvePermission } from '../../src/application/use-cases/ResolvePermission.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { PatternRiskPolicy } from '../../src/domain/permissions/RiskPolicy.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeClock,
  FakePromptGateway,
  FakeVerdicts,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  InMemoryPermissionStore,
  MemoryLogger,
} from '../fakes.ts'

export const SESSION = 'session-1'
export const en = messagesFor('en')

export function incoming(
  overrides: Partial<IncomingPermissionRequest> = {},
): IncomingPermissionRequest {
  return {
    requestId: 'abcde',
    toolName: 'Bash',
    description: 'List the files',
    inputPreview: '{"command":"ls -la"}',
    ...overrides,
  }
}

/**
 * The permission use cases wired to in-memory fakes, with ALICE allowlisted.
 * `prompts` and `chat` replace the fakes the prompts go through (e.g. the real decorators).
 */
export function permissionHarness(
  options: { readonly prompts?: PromptGateway; readonly chat?: ChatGateway } = {},
) {
  const clock = new FakeClock()
  const store = new InMemoryPermissionStore()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const gateway = new FakePromptGateway()
  const verdicts = new FakeVerdicts()
  const brake = new InMemoryBrakeFlag()
  const chat = new FakeChatGateway()
  const prompts = new PermissionPrompts(
    options.prompts ?? gateway,
    options.chat ?? chat,
    en,
    logger,
  )
  let polling = true
  const common = { store, prompts, audit, clock, logger, session: SESSION }
  return {
    clock,
    store,
    allowed,
    audit,
    logger,
    gateway,
    chat,
    brake,
    verdicts,
    setPolling: (value: boolean) => {
      polling = value
    },
    relay: new RelayPermissionRequest({
      ...common,
      allowed,
      risk: new PatternRiskPolicy(),
      canRelay: () => polling,
      brake,
      verdicts,
    }),
    resolve: new ResolvePermission({
      ...common,
      verdicts,
      authorize: new AuthorizeSender(allowed),
      brake,
    }),
    expire: new ExpirePermissions(common),
    markLocal: new MarkPermissionResolvedLocally(common),
  }
}
