/** F8 in the application layer: buttons, the document, redaction before the cap, /diff and taps. */
import { describe, expect, test } from 'bun:test'
import {
  gitActionsKeyboard,
  MAX_DIFF_DOCUMENT_BYTES,
  MAX_UNTRACKED_LISTED,
  renderDiffDocument,
  revertConfirmKeyboard,
} from '../../../src/application/git/diffPresentation.ts'
import {
  encodeGitCallback,
  parseGitCallback,
} from '../../../src/application/git/gitCallbackData.ts'
import { RedactingDocumentGateway } from '../../../src/application/outbound/RedactingDocumentGateway.ts'
import { parsePermissionCallback } from '../../../src/application/permissions/callbackData.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import type { GitChanges, GitReadResult } from '../../../src/application/ports/GitRepository.ts'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import {
  GIT_BUTTON_TTL_MS,
  GIT_CONFIRM_TTL_MS,
  RequestGitAction,
} from '../../../src/application/use-cases/RequestGitAction.ts'
import { ShowDiff } from '../../../src/application/use-cases/ShowDiff.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import type { GitStatus } from '../../../src/domain/git/gitOutput.ts'
import { utf8Length } from '../../../src/domain/lineCut.ts'
import { REDACTION_MARK } from '../../../src/domain/redaction/SecretRedactor.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  ALICE,
  FakeClock,
  FakeDocumentGateway,
  FakeGitRepository,
  FakePromptGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MemoryLogger,
} from '../../fakes.ts'
import { en } from '../permissionHarness.ts'

const GITHUB_TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`

const STATUS: GitStatus = {
  branch: 'main',
  detached: false,
  upstream: { name: 'origin/main', ahead: 1, behind: 0 },
  staged: 1,
  unstaged: 1,
  conflicted: 0,
  untracked: ['notes.txt'],
}

function changes(staged: string, unstaged: string, cut = false): GitChanges {
  return {
    staged: {
      totals: { files: 1, insertions: 2, deletions: 1, binary: 0 },
      patch: { text: staged, cut: false },
    },
    unstaged: {
      totals: { files: 1, insertions: 1, deletions: 0, binary: 1 },
      patch: { text: unstaged, cut },
    },
  }
}

describe('git callback data', () => {
  test('round trip, to the second', () => {
    for (const button of ['commit', 'revert', 'pr', 'confirm_revert', 'cancel_revert'] as const) {
      const data = encodeGitCallback(button, 1_700_000_123_456)
      expect(data).toMatch(/^g1:[crpyx]:[0-9a-z]+$/)
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
      expect(parseGitCallback(data)).toEqual({ button, issuedAt: 1_700_000_123_000 })
    }
  })

  test('strict: anything else is rejected', () => {
    for (const data of [
      undefined,
      '',
      'g1:c',
      'g1:c:',
      'g1:z:abc',
      'g1:C:abc',
      'g2:c:abc',
      'g1:c:ABC',
      'g1:c:abc ',
      ' g1:c:abc',
      'g1:c:abc\n',
      'g1:c:1234567890',
      'g1:c:ab-c',
      'p1:abcde:a',
    ]) {
      expect(parseGitCallback(data)).toBeUndefined()
    }
  })

  test('a g1 button never parses as a permission verdict', () => {
    for (const button of ['commit', 'revert', 'pr', 'confirm_revert', 'cancel_revert'] as const) {
      expect(parsePermissionCallback(encodeGitCallback(button, Date.now()))).toBeUndefined()
    }
  })

  test('keyboards', () => {
    const now = 1_700_000_000_000
    expect(gitActionsKeyboard(en, now)).toEqual([
      [
        { label: en.gitActionButtons.commit, data: encodeGitCallback('commit', now) },
        { label: en.gitActionButtons.revert, data: encodeGitCallback('revert', now) },
      ],
      [{ label: en.gitActionButtons.pr, data: encodeGitCallback('pr', now) }],
    ])
    expect(
      revertConfirmKeyboard(en, now)
        .flat()
        .map((b) => parseGitCallback(b.data)?.button),
    ).toEqual(['confirm_revert', 'cancel_revert'])
  })
})

describe('renderDiffDocument', () => {
  test('staged, unstaged and untracked sections; empty ones left out', () => {
    const text = renderDiffDocument(STATUS, changes('+a\n', '+b', true), en.diffDocument)
    expect(text).toBe(
      [
        `${en.diffDocument.staged}\n+a\n`,
        `${en.diffDocument.unstaged}\n+b\n`,
        `${en.diffDocument.cutWhileReading(5)}\n`,
        `${en.diffDocument.untracked}\nnotes.txt\n`,
      ].join(''),
    )
    expect(
      renderDiffDocument({ ...STATUS, untracked: [] }, changes('', '+b'), en.diffDocument),
    ).toBe(`${en.diffDocument.unstaged}\n+b\n`)
  })

  test('untracked names are one plain line each, and the list is capped', () => {
    const hostile = renderDiffDocument(
      { ...STATUS, untracked: ['evil\nfake +line', 'bidi\u202etxt'] },
      changes('', ''),
      en.diffDocument,
    )
    const listed = hostile.split('\n').slice(1, -1)
    expect(listed).toHaveLength(2)
    expect(hostile).not.toContain('\u202e')

    const many = Array.from({ length: MAX_UNTRACKED_LISTED + 5 }, (_, i) => `f${i}`)
    const capped = renderDiffDocument(
      { ...STATUS, untracked: many },
      changes('', ''),
      en.diffDocument,
    )
    expect(capped.endsWith('… +5\n')).toBe(true)
  })
})

describe('RedactingDocumentGateway: redaction first, then the cap', () => {
  const redactor = createSecretRedactor(['Zq8!vR2#pL-0042'])
  const doc = (text: string, maxBytes: number) => ({
    filename: 'changes.diff',
    text,
    maxBytes,
    cutNote: '# cut',
  })

  test('a small document is redacted and sent whole', async () => {
    const inner = new FakeDocumentGateway()
    const gateway = new RedactingDocumentGateway(inner, redactor, 1024)
    const receipt = await gateway.sendDocument(
      '1',
      doc(`+token=${GITHUB_TOKEN}\n+pw Zq8!vR2#pL-0042\n`, 1000),
      `caption ${GITHUB_TOKEN}`,
    )
    expect(inner.sent[0]?.document.text).toBe(`+token=${REDACTION_MARK}\n+pw ${REDACTION_MARK}\n`)
    expect(inner.sent[0]?.caption).toBe(`caption ${REDACTION_MARK}`)
    expect(receipt).toMatchObject({ redactions: 2, cut: false })
  })

  test('a secret past the cap, a secret on the cut line and a PEM across the cut never leak', async () => {
    const inner = new FakeDocumentGateway()
    const gateway = new RedactingDocumentGateway(inner, redactor, 1024)
    const filler = '+filler line\n'.repeat(200)
    const pem = [
      '+-----BEGIN RSA PRIVATE KEY-----',
      ...Array.from({ length: 50 }, (_, i) => `+MIIEpAIBAAKCAQEA${i}xyzSECRETBODY`),
      '+-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const text = `${filler}+key=${GITHUB_TOKEN}\n${pem}\n${filler}+late=${GITHUB_TOKEN}\n`
    // Every cap position: whatever is kept, no part of any secret survives.
    for (const maxBytes of [
      100,
      utf8Length(filler) + 10,
      utf8Length(filler) + 30,
      utf8Length(filler) + 600,
      5000,
    ]) {
      inner.sent.length = 0
      const receipt = await gateway.sendDocument('1', doc(text, maxBytes), 'c')
      const sent = inner.sent[0]?.document.text ?? ''
      expect(receipt.cut).toBe(true)
      expect(utf8Length(sent)).toBeLessThanOrEqual(maxBytes)
      expect(sent.endsWith('# cut\n')).toBe(true)
      expect(sent).not.toContain('ghp_')
      expect(sent).not.toContain('SECRETBODY')
      expect(sent).not.toContain('A1b2C3d4')
      // Only whole lines before the note.
      expect(sent.slice(0, -'# cut\n'.length).endsWith('\n') || sent === '# cut\n').toBe(true)
    }
  })

  test('the real cap of /diff: a secret far beyond 5 MB still counts as redacted', async () => {
    const inner = new FakeDocumentGateway()
    const gateway = new RedactingDocumentGateway(inner, redactor, 1024)
    const big = `${'+x'.repeat(40)}\n`.repeat(Math.ceil(MAX_DIFF_DOCUMENT_BYTES / 41) + 100)
    const receipt = await gateway.sendDocument(
      '1',
      doc(`${big}+${GITHUB_TOKEN}\n`, MAX_DIFF_DOCUMENT_BYTES),
      'c',
    )
    const sent = inner.sent[0]?.document.text ?? ''
    expect(receipt).toMatchObject({ redactions: 1, cut: true })
    expect(utf8Length(sent)).toBeLessThanOrEqual(MAX_DIFF_DOCUMENT_BYTES)
    expect(sent).not.toContain('ghp_')
  })

  test('the caption is fitted to the limit', async () => {
    const inner = new FakeDocumentGateway()
    await new RedactingDocumentGateway(inner, redactor, 50).sendDocument(
      '1',
      doc('x\n', 100),
      'c'.repeat(500),
    )
    expect(inner.sent[0]?.caption.length).toBeLessThanOrEqual(50)
  })
})

function diffHarness() {
  const clock = new FakeClock()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const git = new FakeGitRepository()
  const documents = new FakeDocumentGateway()
  const prompts = new FakePromptGateway()
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const diff = new ShowDiff({
    git,
    documents,
    prompts,
    target: new AuthorizeReplyTarget(new AuthorizeSender(allowed)),
    project: 'demo',
    messages: en,
    audit,
    clock,
    logger,
  })
  const request = (path = '') => ({ chatId: ALICE.id, actor: `telegram:${ALICE.id}`, path })
  return { clock, git, documents, prompts, audit, logger, diff, request }
}

async function finished(start: ReturnType<ShowDiff['start']>) {
  return start.started ? await start.done : start.outcome
}

describe('ShowDiff', () => {
  const okResult = (c: GitChanges, status = STATUS): GitReadResult => ({
    kind: 'ok',
    status,
    changes: c,
  })

  test('sends the document with the summary as caption, then the buttons', async () => {
    const h = diffHarness()
    h.git.result = okResult(changes('+a\n', '+b\n'))
    const outcome = await finished(h.diff.start(h.request()))
    expect(outcome).toMatchObject({ status: 'sent', files: 2, cut: false })
    expect(h.git.requests[0]).toMatchObject({ withChanges: true })
    const sent = h.documents.sent[0]
    expect(sent?.document).toMatchObject({
      filename: 'changes.diff',
      maxBytes: MAX_DIFF_DOCUMENT_BYTES,
    })
    expect(sent?.caption).toContain('demo')
    expect(sent?.caption).toContain('branch main, ahead 1, behind 0')
    expect(sent?.caption).toContain('+3 −1')
    expect(h.prompts.sent).toEqual([
      {
        chatId: ALICE.id,
        text: en.gitActionsPrompt,
        keyboard: gitActionsKeyboard(en, h.clock.now()),
      },
    ])
    // Counts only in the audit: no path, no content.
    expect(h.audit.entries.at(-1)).toMatchObject({
      event: 'git.diff_sent',
      details: { outcome: 'sent', filtered: false, files: 2 },
    })
    expect(JSON.stringify(h.audit.entries)).not.toContain('notes.txt')
  })

  test('no changes: says so and sends no file and no buttons', async () => {
    const h = diffHarness()
    h.git.result = okResult(changes('', ''), { ...STATUS, untracked: [] })
    expect(await finished(h.diff.start(h.request('src')))).toEqual({
      status: 'no_changes',
      branch: 'main',
      pathFilter: 'src',
    })
    expect(h.documents.sent).toEqual([])
    expect(h.prompts.sent).toEqual([])
  })

  test('untracked files alone are changes', async () => {
    const h = diffHarness()
    h.git.result = okResult(changes('', ''))
    expect(await finished(h.diff.start(h.request()))).toMatchObject({ status: 'sent' })
  })

  test.each([
    [{ kind: 'not_a_repo' } as const, 'not_a_repo' as const],
    [{ kind: 'unavailable', reason: 'git_missing' } as const, 'git_missing' as const],
    [{ kind: 'unavailable', reason: 'unsafe_config' } as const, 'unsafe_config' as const],
  ])('%o is refused', async (result, reason) => {
    const h = diffHarness()
    h.git.result = result
    expect(await finished(h.diff.start(h.request()))).toEqual({ status: 'refused', reason })
    expect(h.documents.sent).toEqual([])
  })

  test('a hostile path is refused before git is asked anything', async () => {
    const h = diffHarness()
    for (const path of ['../etc', '/etc', '-p', ':(glob)*', 'a\nb', 'C:\\x']) {
      const start = h.diff.start(h.request(path))
      expect(start.started).toBe(false)
      expect(await finished(start)).toMatchObject({ status: 'invalid_path' })
    }
    expect(h.git.requests).toEqual([])
    expect(h.audit.entries.every((entry) => entry.event === 'git.diff_not_sent')).toBe(true)
  })

  test('the normalized path is what reaches git', async () => {
    const h = diffHarness()
    h.git.result = okResult(changes('+a\n', ''))
    await finished(h.diff.start(h.request('./src\\app.ts')))
    expect(h.git.requests[0]?.pathFilter).toBe('src/app.ts')
  })

  test('a chat that is not allowlisted gets nothing', async () => {
    const h = diffHarness()
    const start = h.diff.start({ chatId: '999', actor: 'telegram:999', path: '' })
    expect(await finished(start)).toEqual({ status: 'refused', reason: 'chat_not_allowed' })
    expect(h.git.requests).toEqual([])
  })

  test('one at a time, and stop cancels the read in flight', async () => {
    const h = diffHarness()
    let release = () => {}
    h.git.gate = new Promise((resolve) => {
      release = resolve
    })
    h.git.result = okResult(changes('+a\n', ''))
    const first = h.diff.start(h.request())
    expect(first.started).toBe(true)
    expect(await finished(h.diff.start(h.request()))).toEqual({ status: 'refused', reason: 'busy' })
    const stopped = h.diff.stop()
    expect(h.git.requests[0]?.signal?.aborted).toBe(true)
    release()
    await stopped
    // Free again.
    h.git.gate = undefined
    expect((await finished(h.diff.start(h.request()))).status).toBe('sent')
  })

  test('a git failure is a failed outcome, logged', async () => {
    const h = diffHarness()
    h.git.result = new Error('git status timed out')
    expect(await finished(h.diff.start(h.request()))).toEqual({
      status: 'failed',
      error: 'git status timed out',
    })
    expect(h.logger.entries.some((entry) => entry.level === 'error')).toBe(true)
  })
})

function tapHarness() {
  const clock = new FakeClock()
  const delivered: InboundMessage[] = []
  const prompts = new FakePromptGateway()
  const brake = new InMemoryBrakeFlag()
  const audit = new InMemoryAuditLog()
  const action = new RequestGitAction({
    deliver: async (message) => {
      delivered.push(message)
    },
    prompts,
    brake,
    messages: en,
    audit,
    clock,
    logger: new MemoryLogger(),
  })
  const tap = (button: Parameters<typeof encodeGitCallback>[0], issuedAt = clock.now()) => ({
    button,
    issuedAt: Math.floor(issuedAt / 1000) * 1000,
    sender: ALICE,
    chatId: ALICE.id,
    messageId: '42',
  })
  return { clock, delivered, prompts, brake, audit, action, tap }
}

describe('RequestGitAction', () => {
  test('Commit: exactly one fixed instruction into the chain, audited, buttons removed', async () => {
    const h = tapHarness()
    expect(await h.action.execute(h.tap('commit'))).toBe('sent')
    expect(h.delivered).toEqual([
      {
        chatId: ALICE.id,
        messageId: '42',
        chatKind: 'private',
        sender: ALICE,
        text: en.gitInstruction('commit'),
        sentAt: h.clock.now(),
      },
    ])
    expect(h.audit.entries).toMatchObject([
      { event: 'git.action_requested', details: { action: 'commit' } },
    ])
    expect(h.prompts.edits).toEqual([
      {
        ref: { chatId: ALICE.id, messageId: '42' },
        text: en.gitActionSent('commit'),
        keyboard: [],
      },
    ])
  })

  test('Open PR sends its own instruction', async () => {
    const h = tapHarness()
    expect(await h.action.execute(h.tap('pr'))).toBe('sent')
    expect(h.delivered.map((m) => m.text)).toEqual([en.gitInstruction('pr')])
  })

  test('Revert takes two taps; Cancel sends nothing', async () => {
    const h = tapHarness()
    expect(await h.action.execute(h.tap('revert'))).toBe('confirm')
    expect(h.delivered).toEqual([])
    expect(h.prompts.edits[0]?.text).toBe(en.gitRevertConfirm)
    const confirm = h.prompts.edits[0]?.keyboard.flat() ?? []
    expect(confirm.map((b) => parseGitCallback(b.data)?.button)).toEqual([
      'confirm_revert',
      'cancel_revert',
    ])

    expect(await h.action.execute(h.tap('cancel_revert'))).toBe('cancelled')
    expect(h.delivered).toEqual([])
    expect(await h.action.execute(h.tap('confirm_revert'))).toBe('sent')
    expect(h.delivered.map((m) => m.text)).toEqual([en.gitInstruction('revert')])
  })

  test('the instructions are fixed text in both languages', () => {
    for (const action of ['commit', 'revert', 'pr'] as const) {
      expect(en.gitInstruction(action)).toContain('/diff')
    }
    expect(en.gitInstruction('commit')).toContain('Do not push')
  })

  test('stale buttons expire; a confirm expires sooner', async () => {
    const h = tapHarness()
    const issued = h.clock.now()
    h.clock.advance(GIT_BUTTON_TTL_MS + 1_000)
    expect(await h.action.execute(h.tap('commit', issued))).toBe('expired')
    const h2 = tapHarness()
    const confirmIssued = h2.clock.now()
    h2.clock.advance(GIT_CONFIRM_TTL_MS + 1_000)
    expect(await h2.action.execute(h2.tap('confirm_revert', confirmIssued))).toBe('expired')
    // A stamp from the future (beyond clock skew) is not trusted either.
    expect(await h2.action.execute(h2.tap('commit', h2.clock.now() + 3_600_000))).toBe('expired')
    expect([...h.delivered, ...h2.delivered]).toEqual([])
  })

  test('braked: refused, nothing sent, buttons kept', async () => {
    const h = tapHarness()
    h.brake.engage({ engagedAt: h.clock.now(), actor: `telegram:${ALICE.id}`, reason: undefined })
    for (const button of ['commit', 'pr', 'revert', 'confirm_revert'] as const) {
      expect(await h.action.execute(h.tap(button))).toBe('braked')
    }
    expect(h.delivered).toEqual([])
    expect(h.prompts.edits).toEqual([])
  })
})
