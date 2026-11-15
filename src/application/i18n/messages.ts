/**
 * Every user-facing string (bot replies and CLI output). Spanish is the
 * default; `TELEGRAM_BRIDGE_LOCALE=en` switches to English. Diagnostic logs
 * on stderr are not user-facing and stay in English.
 */
import type { CaptureKind } from '../../domain/capture/CaptureTarget.ts'
import { sanitizeDisplayText, sanitizeUsername } from '../../domain/displayText.ts'
import type { DiffPathProblem } from '../../domain/git/diffPathFilter.ts'
import type { PermissionOutcome } from '../permissions/PermissionOutcome.ts'
import type { CaptureUnavailable } from '../ports/ScreenCapturer.ts'
import type { TranscriberUnavailable } from '../ports/Transcriber.ts'

export type Locale = 'es' | 'en'

export const DEFAULT_LOCALE: Locale = 'es'

export interface ClaimantView {
  readonly displayName: string
  readonly username: string | undefined
  readonly id: string
}

/** Facts `/status` reports; only what the process actually knows. */
export interface StatusView {
  readonly botUsername: string | undefined
  /** ISO date-time the sender was paired, if known. */
  readonly pairedSince: string | undefined
  /** Whether the MCP connection to Claude Code is open. */
  readonly sessionConnected: boolean
  /** Permission requests of this session still waiting for an answer. */
  readonly pendingPermissions: number
  /** The panic brake; `since` is ISO 8601, undefined when the flag cannot be read. */
  readonly brake: { readonly engaged: false } | { readonly engaged: true; readonly since?: string }
  /** What `/shot` can capture on this machine; undefined when screenshots are not wired. */
  readonly captureKinds?: readonly CaptureKind[]
  /** Files received and kept (F10); undefined when incoming files are not wired. */
  readonly inbox?: { readonly files: number; readonly bytes: number }
  /** One line about the project's git work tree (F8); undefined when unknown. */
  readonly git?: GitStatusLineView
}

/** `/status`'s git line (F8). Branch names come from the repository: untrusted. */
export type GitStatusLineView =
  | { readonly kind: 'not_a_repo' }
  | {
      readonly kind: 'repo'
      readonly branch: string | undefined
      readonly ahead: number | undefined
      readonly behind: number | undefined
      readonly staged: number
      readonly unstaged: number
      readonly untracked: number
      readonly conflicted: number
    }

/** The caption of the `.diff` document (F8). Names come from the repository: untrusted. */
export interface DiffSummaryView {
  readonly project: string | undefined
  readonly status: Extract<GitStatusLineView, { kind: 'repo' }>
  readonly files: number
  readonly insertions: number
  readonly deletions: number
  readonly binary: number
  readonly pathFilter: string | undefined
}

export type DiffProblemView =
  | { readonly problem: 'not_a_repo' | 'git_missing' | 'unsafe_config' | 'busy' | 'failed' }
  | { readonly problem: 'invalid_path'; readonly reason: DiffPathProblem }
  | {
      readonly problem: 'no_changes'
      readonly branch: string | undefined
      readonly pathFilter: string | undefined
    }

/** What a `/diff` button asks the session to do (F8). */
export type GitAction = 'commit' | 'revert' | 'pr'

/** What a tap on a `/diff` button did. */
export type GitTapOutcome = 'sent' | 'confirm' | 'cancelled' | 'expired' | 'braked'

/** The pinned status message (F9); every field comes from hooks or the bridge, never from Claude's text. */
export interface PinnedStatusView {
  readonly project: string | undefined
  readonly state: 'unknown' | 'idle' | 'working' | 'waiting' | 'braked' | 'ended'
  /** Local time `HH:MM` the state began. */
  readonly since: string | undefined
  /** Already sanitized and short (`summarizeToolUse`). */
  readonly activity: { readonly tool: string; readonly detail?: string } | undefined
  readonly pendingPermissions: number
  readonly pendingChoices: number
  readonly lastFinished: string | undefined
}

/** What a tap on a choice button (or the typed "other" answer) did. */
export type ChoiceOutcome =
  | 'answered'
  /** "Other..." tapped: the next text message is the answer. */
  | 'awaiting_text'
  | 'already_answered'
  | 'expired'
  | 'not_found'
  | 'not_allowed'
  | 'braked'
  | 'delivery_failed'

/** How a choice was closed, for the line under the question. */
export type ChoiceStatusView =
  | {
      readonly status: 'answered'
      readonly label: string
      readonly who: string
      readonly at: string
    }
  | { readonly status: 'answered_with_text'; readonly who: string; readonly at: string }
  | { readonly status: 'awaiting_text' | 'expired' | 'cancelled' }

/** One page of `/skills`; names match `SKILL_NAME`, descriptions are sanitized. */
export interface SkillsMenuView {
  readonly skills: readonly { readonly name: string; readonly description: string }[]
  /** 0-based. */
  readonly page: number
  readonly pages: number
  readonly projectKnown: boolean
}

export type SkillTapOutcome = 'sent' | 'not_found' | 'braked'

/** What a tap on a memory proposal did (F12). */
export type MemoryTapOutcome =
  | 'approved'
  | 'approved_braked'
  | 'rejected'
  | 'rejected_braked'
  | 'already_resolved'
  | 'expired'
  | 'not_found'
  | 'not_allowed'
  | 'write_failed'

/** Whether the session heard about a tap on a memory proposal. */
export type MemoryNotice = 'told' | 'braked' | 'not_delivered'

/** How a memory proposal ended, for the line under the lines. */
export type MemoryStatusView =
  | {
      readonly status: 'approved'
      readonly who: string
      readonly at: string
      /** Relative path of the file written. */
      readonly file: string
      /** Whether Claude was told: never while braked. */
      readonly notice: MemoryNotice
    }
  | {
      readonly status: 'rejected'
      readonly who: string
      readonly at: string
      readonly notice: MemoryNotice
    }
  | { readonly status: 'write_failed' }
  | { readonly status: 'expired' }
  | { readonly status: 'cancelled' }

/** A saved summary (F12): its path and, when short enough for the chat, its text. */
export interface SummarySavedView {
  readonly path: string
  /** Undefined when the summary is too long to show in a few messages. */
  readonly document: string | undefined
  /** Characters in the summary. */
  readonly length: number
}

/** What the session is told after a tap on a memory proposal (F12). Fixed text plus counts. */
export interface MemorySessionView {
  readonly outcome: 'approved' | 'rejected'
  readonly proposalId: string
  readonly lines: number
  readonly file: string
}

/** Why a voice note produced no transcript to send (F13). */
export type VoiceRefusalReason =
  /** Longer than the cap, or no duration declared. */
  | 'too_long'
  | 'too_large'
  | 'empty'
  /** The content is not an Ogg file. */
  | 'not_ogg'
  /** Too many voice notes waiting already. */
  | 'busy'
  | 'download_failed'
  | 'conversion_failed'
  | 'transcription_failed'
  | 'timeout'
  | 'output_too_large'
  /** The transcript was empty. */
  | 'nothing_heard'
  /** The transcript does not fit one message. */
  | 'text_too_long'
  /** Redaction would have changed the transcript. */
  | 'contains_secret'
  /** The prompt could not be sent. */
  | 'not_shown'

export interface VoiceRefusalView {
  readonly reason: VoiceRefusalReason
  readonly maxSeconds: number
  readonly maxMegabytes: number
}

/** The transcript as offered with Send and Discard (F13). */
export interface VoicePromptView {
  readonly text: string
  /** The note's declared duration. */
  readonly seconds: number
}

/** What a tap on a voice transcript did (F13). */
export type VoiceTapOutcome =
  | 'sent'
  | 'discarded'
  | 'braked'
  | 'already_resolved'
  | 'expired'
  | 'not_found'
  | 'not_allowed'

/** How a voice transcript ended, for the line under the text. */
export type VoiceStatusView =
  | { readonly status: 'sent' | 'discarded'; readonly who: string; readonly at: string }
  | { readonly status: 'expired' }
  | { readonly status: 'cancelled' }

/** Why an incoming file was not passed to Claude. */
export interface AttachmentRefusalView {
  readonly reason:
    | 'too_large'
    | 'empty'
    | 'type_not_allowed'
    | 'type_mismatch'
    | 'rate_limited'
    | 'download_failed'
  readonly maxMegabytes: number
  readonly allowed: readonly string[]
}

/** What a screenshot caption describes; `url` is shown to the owner, untrusted plain text. */
export type ShotCaptionView =
  | { readonly kind: 'screen' }
  | { readonly kind: 'url'; readonly url: string }

/** Why `/shot` produced no image. */
export type ShotProblemView =
  | { readonly problem: 'busy' | 'invalid_url' | 'failed' }
  | {
      readonly problem: 'unavailable'
      readonly kind: CaptureKind
      readonly reason: CaptureUnavailable['reason'] | undefined
      readonly remedies: readonly string[]
    }
  | { readonly problem: 'too_large'; readonly megabytes: number }

/** What `/stop` did, reported truthfully. */
export interface StopReportView {
  readonly brake: 'engaged' | 'already_engaged'
  /** ISO 8601; undefined when the existing flag cannot be read. */
  readonly since: string | undefined
  /** Pending permission requests of this session that got a deny verdict. */
  readonly denied: number
  /** `skipped` when the brake was already engaged. */
  readonly interrupt: 'sent' | 'unavailable' | 'failed' | 'skipped'
}

/** What the PreToolUse hook tells the person at the terminal. */
export interface BrakeHookView {
  /** Undefined when the flag file exists but cannot be read. */
  readonly source: 'telegram' | 'terminal' | 'unknown' | undefined
  readonly since: string | undefined
  readonly reason: string | undefined
  /** The flag file, for when nothing else can release it. */
  readonly flagPath: string
}

/** A permission prompt's content; every field from Claude Code is untrusted plain text. */
export interface PermissionPromptView {
  readonly requestId: string
  readonly toolName: string
  readonly description: string
  readonly inputPreview: string
  readonly risk: 'low' | 'high'
}

/** Who closed a request and when (ISO 8601). */
export interface PermissionDecisionView {
  readonly who: string
  readonly at: string
}

/** A hook notice; `project` is the session's directory name, `message` untrusted plain text. */
export interface SessionNoticeView {
  readonly project: string | undefined
  readonly message: string | undefined
}

export interface CommandHelp {
  readonly name: string
  readonly description: string
}

export interface Messages {
  // Bot replies
  readonly pairingClaimedReply: string
  readonly startGreeting: string
  readonly help: (commands: readonly CommandHelp[]) => string
  readonly status: (view: StatusView) => string
  readonly commandStartDescription: string
  readonly commandHelpDescription: string
  readonly commandStatusDescription: string
  readonly commandStopDescription: string
  readonly commandResumeDescription: string
  readonly slowDown: string
  /** Sent once when messages from before this session were dropped. */
  readonly staleMessagesIgnored: string
  readonly onlyTextSupported: string
  readonly queued: string
  readonly deliveryFailed: string
  readonly messageTooLong: (max: number) => string

  // Bot: permission relay
  readonly permissionPrompt: (view: PermissionPromptView) => string
  /** Stands for the description and input of a prompt sent in full just before it (M2). */
  readonly permissionDetailsAbove: string
  /** The plain message(s) with the whole description and input, sent before the buttons. */
  readonly permissionDetails: (view: PermissionPromptView) => string
  /** Appended when part of a prompt could not be shown at all. */
  readonly permissionHidden: (count: number) => string
  readonly permissionAwaitingConfirmation: (seconds: number) => string
  readonly permissionApproved: (decision: PermissionDecisionView) => string
  readonly permissionDenied: (decision: PermissionDecisionView) => string
  readonly permissionDeniedByStop: (decision: PermissionDecisionView) => string
  readonly permissionExpired: string
  readonly permissionResolvedLocally: string
  readonly permissionButtons: Readonly<Record<'approve' | 'deny' | 'confirm' | 'cancel', string>>
  /** Short (a toast holds 200 characters): what a tap or a text verdict did. */
  readonly permissionFeedback: (outcome: PermissionOutcome) => string

  // Bot: notices from hooks
  readonly noticeFinished: (view: SessionNoticeView) => string
  readonly noticeAttention: (view: SessionNoticeView) => string

  // Bot: panic brake (F6)
  readonly stopReport: (view: StopReportView) => string
  readonly resumeReleased: string
  readonly resumeNotEngaged: string
  /** A message that was not forwarded because the brake is engaged. */
  readonly brakeHeldMessage: string

  // Bot: screenshots (F5)
  readonly commandShotDescription: string
  readonly shotCaption: (view: ShotCaptionView) => string
  readonly shotProblem: (view: ShotProblemView) => string
  /** Sent at once; the image (or the problem) follows when the capture ends. */
  readonly shotCapturing: string

  // Bot: choices (F7)
  /** The question Claude asks; untrusted plain text. */
  readonly choicePrompt: (question: string) => string
  /** Stands for a question sent in full just before the buttons (too long for one message). */
  readonly choiceQuestionAbove: string
  readonly choiceOtherButton: string
  readonly choiceStatus: (view: ChoiceStatusView) => string
  /** Short (a toast holds 200 characters). */
  readonly choiceFeedback: (outcome: ChoiceOutcome) => string

  // Bot: skills (F7)
  readonly commandSkillsDescription: string
  readonly skillsMenu: (view: SkillsMenuView) => string
  readonly skillsNone: (projectKnown: boolean) => string
  readonly skillsPageButtons: { readonly previous: string; readonly next: string }
  readonly skillFeedback: (outcome: SkillTapOutcome) => string

  // Bot: incoming files (F10)
  readonly attachmentRefused: (view: AttachmentRefusalView) => string

  // Bot: git from the chat (F8)
  readonly commandDiffDescription: string
  readonly diffProblem: (view: DiffProblemView) => string
  /** The document's caption (fitted to 1024 characters after redaction). */
  readonly diffSummary: (view: DiffSummaryView) => string
  readonly diffDocument: {
    readonly staged: string
    readonly unstaged: string
    readonly untracked: string
    /** A patch longer than the read cap: whole lines kept. */
    readonly cutWhileReading: (megabytes: number) => string
    /** The document was cut to the size cap after redaction. */
    readonly cutToFit: (megabytes: number) => string
  }
  /** The fixed text over the buttons: nothing from the repository. */
  readonly gitActionsPrompt: string
  readonly gitActionButtons: Readonly<
    Record<'commit' | 'revert' | 'pr' | 'confirmRevert' | 'cancel', string>
  >
  readonly gitRevertConfirm: string
  readonly gitRevertCancelled: string
  readonly gitActionSent: (action: GitAction) => string
  /** The fixed instruction a tap sends to the session, as owner text. */
  readonly gitInstruction: (action: GitAction) => string
  /** Short (a toast holds 200 characters). */
  readonly gitTapFeedback: (outcome: GitTapOutcome) => string

  // Bot: charts (F11)
  /** The caption under a chart; `caption` is Claude's text, already sanitized. */
  readonly chartCaption: (caption: string | undefined) => string

  // Bot: session summary and memory (F12)
  readonly commandWrapDescription: string
  /** The fixed instruction `/wrap` sends to the session; nothing is interpolated. */
  readonly wrapInstruction: string
  readonly wrapSent: string
  /** The chat copy of a saved summary: the path, then the summary itself. */
  readonly summarySaved: (view: SummarySavedView) => string
  readonly memoryPrompt: (lines: readonly string[]) => string
  readonly memoryButtons: { readonly approve: string; readonly reject: string }
  readonly memoryStatus: (view: MemoryStatusView) => string
  readonly memoryFeedback: (outcome: MemoryTapOutcome) => string
  /** What the session reads after a tap; fixed text, ids and counts only. */
  readonly memorySessionOutcome: (view: MemorySessionView) => string

  // Bot: voice notes (F13)
  /** Voice notes cannot be transcribed here: how to enable it. Nothing was downloaded. */
  readonly voiceUnavailable: (reason: TranscriberUnavailable) => string
  readonly voiceRefused: (view: VoiceRefusalView) => string
  readonly voicePrompt: (view: VoicePromptView) => string
  readonly voiceButtons: { readonly send: string; readonly discard: string }
  readonly voiceStatus: (view: VoiceStatusView) => string
  readonly voiceFeedback: (outcome: VoiceTapOutcome) => string

  // Bot: pinned status (F9)
  readonly commandPinDescription: string
  readonly commandUnpinDescription: string
  readonly pinnedStatus: (view: PinnedStatusView) => string
  readonly pinFailed: string
  readonly pinNotPinned: string
  readonly unpinDone: string
  readonly unpinNothing: string

  // PreToolUse hook (F6): shown at the terminal, and to Claude
  readonly brakeStopReason: (view: BrakeHookView) => string
  readonly brakeToolDenied: string

  // CLI: stop and resume
  readonly cliStopEngaged: string
  readonly cliStopAlreadyEngaged: (since: string | undefined) => string
  readonly cliResumeReleased: string
  readonly cliResumeNotEngaged: string

  // CLI: general
  readonly usage: string
  readonly unknownCommand: string
  readonly unexpectedError: (detail: string) => string
  readonly notConfigured: string
  /** `TELEGRAM_BRIDGE_HOME` or `CLAUDE_CONFIG_DIR` is relative. */
  readonly invalidStateDir: (variable: string) => string

  // CLI: init
  readonly initTokenPrompt: string
  readonly initTokenEmpty: string
  readonly initNeedsTerminal: string
  readonly initStdinIsTerminal: string
  readonly initValidating: string
  readonly initInvalidToken: string
  readonly initUnreachable: (detail: string) => string
  readonly initDone: (username: string) => string
  readonly initEnvOverride: string
  readonly initNextStep: string

  // CLI: pair
  readonly pairScan: string
  readonly pairLink: (link: string) => string
  readonly pairExpiresIn: (seconds: number) => string
  readonly pairUsingChannel: string
  readonly pairPollingHere: string
  readonly pairAnotherInProgress: (pid: number) => string
  readonly pairClaimedBy: (claimant: ClaimantView) => string
  readonly pairConfirmPrompt: string
  readonly pairConfirmed: (claimant: ClaimantView) => string
  readonly pairDeclined: string
  readonly pairExpired: string
  readonly pairCancelled: string
  readonly pairTokenRejected: string
  readonly pairPollingConflict: string

  // CLI: access
  readonly accessListEmpty: string
  readonly accessListHeader: string
  readonly accessListRow: (sender: ClaimantView, addedAt: string) => string
  readonly accessRevoked: (id: string) => string
  readonly accessNotFound: (id: string) => string
  readonly accessInvalidId: string
}

/**
 * How every hint tells the user to run the CLI: the package script, from the
 * telegram-bridge folder. Nothing puts a `telegram-bridge` command on PATH,
 * so hints never name one. The brake hook's fallback text repeats it.
 */
export const CLI_INVOCATION = 'bun run bridge --'

const USAGE_ES = `Uso: ${CLI_INVOCATION} <comando>  (en la carpeta de telegram-bridge)

Comandos:
  init [--token-stdin]   Configura el bot con el token de BotFather
  pair                   Empareja tu cuenta de Telegram con este PC
  access list            Lista las cuentas permitidas
  access revoke <id>     Retira el acceso a una cuenta
  stop [motivo]          Activa el freno: Claude se detiene en su próxima herramienta
  resume                 Retira el freno
  --help                Muestra esta ayuda

El token nunca se pasa como argumento: init lo pide sin mostrarlo o lo lee de stdin.`

const USAGE_EN = `Usage: ${CLI_INVOCATION} <command>  (in the telegram-bridge folder)

Commands:
  init [--token-stdin]   Configure the bot with the BotFather token
  pair                   Pair your Telegram account with this PC
  access list            List the allowed accounts
  access revoke <id>     Remove an account's access
  stop [reason]          Engage the brake: Claude stops at its next tool call
  resume                 Release the brake
  --help                Show this help

The token is never passed as an argument: init asks for it without echo or reads it from stdin.`

/**
 * A claimant or allowed sender on one line, id first. The name and the
 * username are chosen by the account owner, so they are sanitized here too
 * (rows stored before boundary sanitizing existed) and the name is quoted.
 */
function who(c: ClaimantView): string {
  const username = sanitizeUsername(c.username)
  const handle = username === undefined ? '' : ` (@${username})`
  return `id ${sanitizeDisplayText(c.id)}, "${sanitizeDisplayText(c.displayName)}"${handle}`
}

interface ClaimantLabels {
  readonly header: string
  readonly id: string
  readonly name: string
  readonly username: string
  readonly none: string
}

/** The pairing confirmation: the numeric id on its own line, before anything the claimant chose. */
function claimant(c: ClaimantView, labels: ClaimantLabels): string {
  const username = sanitizeUsername(c.username)
  return [
    labels.header,
    `  ${labels.id}: ${sanitizeDisplayText(c.id)}`,
    `  ${labels.name}: "${sanitizeDisplayText(c.displayName)}"`,
    `  ${labels.username}: ${username === undefined ? labels.none : `@${username}`}`,
  ].join('\n')
}

function notice(headline: string, view: SessionNoticeView): string {
  const body = view.message?.trim()
  return body === undefined || body === '' ? headline : `${headline}\n\n${body}`
}

function commandList(commands: readonly CommandHelp[]): string {
  return commands.map((c) => `/${c.name} - ${c.description}`).join('\n')
}

function lines(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined).join('\n')
}

/** Branch, project and path names come from the repository or the disk: shown sanitized. */
function shown(text: string, max = 100): string {
  return sanitizeDisplayText(text, max)
}

const DIFF_PATH_PROBLEM_ES: Readonly<Record<DiffPathProblem, string>> = {
  empty: 'está vacía',
  too_long: 'es demasiado larga',
  control: 'tiene caracteres de control o invisibles',
  absolute: 'es absoluta',
  traversal: 'usa ..',
  option: 'empieza con -',
  magic: 'empieza con : (magia de pathspec)',
}

const DIFF_PATH_PROBLEM_EN: Readonly<Record<DiffPathProblem, string>> = {
  empty: 'it is empty',
  too_long: 'it is too long',
  control: 'it has control or invisible characters',
  absolute: 'it is absolute',
  traversal: 'it uses ..',
  option: 'it starts with -',
  magic: 'it starts with : (pathspec magic)',
}

const GIT_ACTION_ES: Readonly<Record<GitAction, string>> = {
  commit: 'Commit',
  revert: 'Revertir',
  pr: 'Abrir PR',
}

const GIT_ACTION_EN: Readonly<Record<GitAction, string>> = {
  commit: 'Commit',
  revert: 'Revert',
  pr: 'Open PR',
}

/**
 * The instructions a `/diff` button sends to the session (F8). Fixed text,
 * nothing from the repository interpolated; it says the owner asked through
 * a button, and the session still asks permission for every tool call.
 */
const GIT_INSTRUCTION_ES: Readonly<Record<GitAction, string>> = {
  commit:
    'El dueño pulsó "Commit" bajo /diff en Telegram. Revisa los cambios actuales y crea un commit con un mensaje claro. No hagas push.',
  revert:
    'El dueño pulsó "Revertir" bajo /diff en Telegram y lo confirmó. Descarta todos los cambios sin commit del árbol de trabajo (solo archivos con seguimiento; lista los archivos sin seguimiento en lugar de borrarlos).',
  pr: 'El dueño pulsó "Abrir PR" bajo /diff en Telegram. Haz push de la rama actual y abre un pull request para ella; informa la URL.',
}

const GIT_INSTRUCTION_EN: Readonly<Record<GitAction, string>> = {
  commit:
    'The owner tapped "Commit" under /diff in Telegram. Review the current changes and create a commit with a clear message. Do not push.',
  revert:
    'The owner tapped "Revert" under /diff in Telegram and confirmed it. Discard all uncommitted changes in the working tree (tracked files only; list untracked files instead of deleting them).',
  pr: 'The owner tapped "Open PR" under /diff in Telegram. Push the current branch and open a pull request for it; report the URL.',
}

const GIT_TAP_ES: Readonly<Record<GitTapOutcome, string>> = {
  sent: 'Enviado a Claude.',
  confirm: 'Pulsa "Confirmar revertir" para seguir.',
  cancelled: 'Cancelado.',
  expired: 'Esos botones ya vencieron. Envía /diff de nuevo.',
  braked: 'El freno está activo: no se envió nada a Claude. Envía /resume primero.',
}

const GIT_TAP_EN: Readonly<Record<GitTapOutcome, string>> = {
  sent: 'Sent to Claude.',
  confirm: 'Tap "Confirm revert" to go ahead.',
  cancelled: 'Cancelled.',
  expired: 'Those buttons have expired. Send /diff again.',
  braked: 'The brake is engaged: nothing was sent to Claude. Send /resume first.',
}

type RepoLine = Extract<GitStatusLineView, { kind: 'repo' }>

function gitCountsEs(v: RepoLine): string {
  return [
    `${v.staged} preparados`,
    `${v.unstaged} sin preparar`,
    `${v.untracked} sin seguimiento`,
    ...(v.conflicted > 0 ? [`${v.conflicted} en conflicto`] : []),
  ].join(', ')
}

function gitCountsEn(v: RepoLine): string {
  return [
    `${v.staged} staged`,
    `${v.unstaged} unstaged`,
    `${v.untracked} untracked`,
    ...(v.conflicted > 0 ? [`${v.conflicted} conflicted`] : []),
  ].join(', ')
}

function branchEs(v: RepoLine): string {
  const name = v.branch === undefined ? 'HEAD separado' : `rama ${shown(v.branch)}`
  return v.ahead === undefined ? name : `${name}, ${v.ahead} por delante, ${v.behind} por detrás`
}

function branchEn(v: RepoLine): string {
  const name = v.branch === undefined ? 'detached HEAD' : `branch ${shown(v.branch)}`
  return v.ahead === undefined ? name : `${name}, ahead ${v.ahead}, behind ${v.behind}`
}

function pinnedStateEs(v: PinnedStatusView): string {
  const since = v.since === undefined ? '' : ` desde las ${v.since}`
  switch (v.state) {
    case 'unknown':
      return 'desconocido (aún no llegan eventos de los hooks)'
    case 'idle':
      return `en espera${since}`
    case 'working':
      return `trabajando${since}`
    case 'waiting':
      return `esperando tu respuesta${since}`
    case 'braked':
      return `frenado${since} (/resume lo retira)`
    case 'ended':
      return `sesión terminada${since}`
  }
}

function pinnedStateEn(v: PinnedStatusView): string {
  const since = v.since === undefined ? '' : ` since ${v.since}`
  switch (v.state) {
    case 'unknown':
      return 'unknown (no hook events yet)'
    case 'idle':
      return `idle${since}`
    case 'working':
      return `working${since}`
    case 'waiting':
      return `waiting for your answer${since}`
    case 'braked':
      return `braked${since} (/resume releases it)`
    case 'ended':
      return `session ended${since}`
  }
}

function gitLineEs(v: GitStatusLineView | undefined): string | undefined {
  if (v === undefined) return undefined
  if (v.kind === 'not_a_repo') return 'Git: el directorio del proyecto no es un repositorio git'
  return `Git: ${branchEs(v)} · ${gitCountsEs(v)}`
}

function gitLineEn(v: GitStatusLineView | undefined): string | undefined {
  if (v === undefined) return undefined
  if (v.kind === 'not_a_repo') return 'Git: the project directory is not a git work tree'
  return `Git: ${branchEn(v)} · ${gitCountsEn(v)}`
}

const INTERRUPT_ES: Readonly<Record<StopReportView['interrupt'], string | undefined>> = {
  sent: 'Se envió Escape a la terminal de Claude Code (tmux) para cortar el turno en curso.',
  unavailable:
    'Cortar el turno en curso no está disponible aquí (sin tmux): Claude se detendrá en su próxima herramienta.',
  failed: 'No se pudo enviar Escape por tmux: Claude se detendrá en su próxima herramienta.',
  skipped: undefined,
}

const INTERRUPT_EN: Readonly<Record<StopReportView['interrupt'], string | undefined>> = {
  sent: 'Sent Escape to the Claude Code terminal (tmux) to interrupt the current turn.',
  unavailable:
    'Interrupting the current turn is not available here (no tmux): Claude will stop at its next tool call.',
  failed: 'Could not send Escape through tmux: Claude will stop at its next tool call.',
  skipped: undefined,
}

const CAPTURE_KIND_ES: Readonly<Record<CaptureKind, string>> = {
  screen: 'pantalla',
  url: 'páginas web',
}
const CAPTURE_KIND_EN: Readonly<Record<CaptureKind, string>> = {
  screen: 'screen',
  url: 'web pages',
}

function captureLine(
  label: string,
  none: string,
  names: Readonly<Record<CaptureKind, string>>,
  kinds: readonly CaptureKind[] | undefined,
): string | undefined {
  if (kinds === undefined) return undefined
  return `${label}: ${kinds.length === 0 ? none : kinds.map((kind) => names[kind]).join(', ')}`
}

const SHOT_UNAVAILABLE_ES: Readonly<Record<CaptureUnavailable['reason'], string>> = {
  no_display:
    'no hay sesión gráfica (ni DISPLAY ni WAYLAND_DISPLAY): Claude Code debe correr dentro del escritorio',
  no_tool: 'no se encontró ninguna herramienta de captura',
  no_browser: 'no se encontró un navegador Chromium, Chrome, Brave o Edge',
  invalid_browser_override:
    'TELEGRAM_BRIDGE_BROWSER no es la ruta absoluta de un programa que exista',
}

const SHOT_UNAVAILABLE_EN: Readonly<Record<CaptureUnavailable['reason'], string>> = {
  no_display:
    'there is no graphical session (neither DISPLAY nor WAYLAND_DISPLAY): Claude Code must run inside the desktop',
  no_tool: 'no screenshot tool was found',
  no_browser: 'no Chromium, Chrome, Brave or Edge browser was found',
  invalid_browser_override:
    'TELEGRAM_BRIDGE_BROWSER is not the absolute path of an existing program',
}

function remedies(prefix: string, list: readonly string[]): string | undefined {
  return list.length === 0 ? undefined : `${prefix} ${list.join(', ')}.`
}

function inboxLine(
  label: (files: number, megabytes: string) => string,
  inbox: StatusView['inbox'],
): string | undefined {
  return inbox === undefined ? undefined : label(inbox.files, (inbox.bytes / 1_000_000).toFixed(1))
}

/** Longest description shown per skill in the list (the button carries only the name). */
const SKILL_DESCRIPTION_SHOWN = 90

function skillLines(view: SkillsMenuView): string {
  return view.skills
    .map((skill) => {
      const description = sanitizeDisplayText(skill.description, SKILL_DESCRIPTION_SHOWN)
      // No leading slash: Telegram would turn it into a link that sends the bare command.
      return description === '' ? `• ${skill.name}` : `• ${skill.name} - ${description}`
    })
    .join('\n')
}

const CHOICE_FEEDBACK_ES: Readonly<Record<ChoiceOutcome, string>> = {
  answered: 'Enviado a Claude.',
  awaiting_text: 'Escribe tu respuesta en el próximo mensaje.',
  already_answered: 'Esa pregunta ya se respondió.',
  expired: 'Esa pregunta ya venció.',
  not_found: 'Esa pregunta ya no existe.',
  not_allowed: 'No autorizado.',
  braked: 'El freno está activo: no se envió nada a Claude. Envía /resume primero.',
  delivery_failed: 'No se pudo entregar la respuesta a Claude. Inténtalo de nuevo.',
}

const CHOICE_FEEDBACK_EN: Readonly<Record<ChoiceOutcome, string>> = {
  answered: 'Sent to Claude.',
  awaiting_text: 'Write your answer as your next message.',
  already_answered: 'That question was already answered.',
  expired: 'That question has expired.',
  not_found: 'That question no longer exists.',
  not_allowed: 'Not authorized.',
  braked: 'The brake is engaged: nothing was sent to Claude. Send /resume first.',
  delivery_failed: 'The answer could not be delivered to Claude. Try again.',
}

const ATTACHMENT_REASON_ES: Readonly<Record<AttachmentRefusalView['reason'], string>> = {
  too_large: 'es más grande que el límite',
  empty: 'está vacío',
  type_not_allowed: 'su tipo no está permitido',
  type_mismatch: 'su contenido no corresponde a su extensión',
  rate_limited: 'enviaste demasiados archivos seguidos; espera un poco',
  download_failed: 'no se pudo descargar',
}

const ATTACHMENT_REASON_EN: Readonly<Record<AttachmentRefusalView['reason'], string>> = {
  too_large: 'it is larger than the limit',
  empty: 'it is empty',
  type_not_allowed: 'its type is not allowed',
  type_mismatch: 'its content does not match its extension',
  rate_limited: 'you sent too many files in a row; wait a little',
  download_failed: 'it could not be downloaded',
}

/** `/wrap` (F12): fixed text, nothing interpolated. Claude answers with the two tools. */
const WRAP_INSTRUCTION_ES =
  'El dueño envió /wrap en Telegram para cerrar esta sesión. 1) Escribe en Markdown un resumen breve de la sesión (qué se hizo, decisiones y por qué, pendientes y próximos pasos) y guárdalo con la herramienta save_session_summary, con el chat_id de este mensaje y un título corto. No escribas el archivo tú mismo. 2) Si hay aprendizajes duraderos que valga la pena conservar para futuras sesiones de este proyecto (convenciones, comandos, trampas), propónlos con la herramienta propose_memory: como mucho 8 líneas cortas de una sola línea cada una. No edites CLAUDE.md tú mismo: solo se escriben las líneas que el dueño apruebe con el botón. Si no hay nada que recordar, omite el paso 2 y dilo en tu respuesta.'

const WRAP_INSTRUCTION_EN =
  'The owner sent /wrap in Telegram to close this session. 1) Write a concise Markdown summary of the session (what was done, decisions and why, open items and next steps) and save it with the save_session_summary tool, using the chat_id of this message and a short title. Do not write the file yourself. 2) If there are durable lessons worth keeping for future sessions in this project (conventions, commands, pitfalls), propose them with the propose_memory tool: at most 8 short items, one line each. Do not edit CLAUDE.md yourself: only the lines the owner approves with the button are written. If nothing is worth remembering, skip step 2 and say so in your reply.'

const MEMORY_FEEDBACK_ES: Readonly<Record<MemoryTapOutcome, string>> = {
  approved: 'Escrito en CLAUDE.md.',
  approved_braked: 'Escrito en CLAUDE.md. El freno está activo: no se avisó a Claude.',
  rejected: 'Rechazado: no se escribió nada.',
  rejected_braked: 'Rechazado: no se escribió nada. El freno está activo: no se avisó a Claude.',
  already_resolved: 'Esa propuesta ya se resolvió.',
  expired: 'Esa propuesta ya venció.',
  not_found: 'Esa propuesta ya no existe.',
  not_allowed: 'No autorizado.',
  write_failed:
    'No se pudo escribir CLAUDE.md; la propuesta sigue abierta. Los detalles están en el log.',
}

const MEMORY_FEEDBACK_EN: Readonly<Record<MemoryTapOutcome, string>> = {
  approved: 'Written to CLAUDE.md.',
  approved_braked: 'Written to CLAUDE.md. The brake is engaged: Claude was not told.',
  rejected: 'Rejected: nothing was written.',
  rejected_braked: 'Rejected: nothing was written. The brake is engaged: Claude was not told.',
  already_resolved: 'That proposal was already resolved.',
  expired: 'That proposal has expired.',
  not_found: 'That proposal no longer exists.',
  not_allowed: 'Not authorized.',
  write_failed:
    'CLAUDE.md could not be written; the proposal is still open. Details are in the log.',
}

const MEMORY_NOTICE_ES: Readonly<Record<MemoryNotice, string>> = {
  told: '',
  braked: ' El freno estaba activo: no se avisó a Claude.',
  not_delivered: ' No se pudo avisar a Claude.',
}

const MEMORY_NOTICE_EN: Readonly<Record<MemoryNotice, string>> = {
  told: '',
  braked: ' The brake was engaged: Claude was not told.',
  not_delivered: ' Claude could not be told.',
}

const VOICE_SETUP_ES = 'Guía: docs/flows/F13.md. La nota no se descargó.'
const VOICE_SETUP_EN = 'Guide: docs/flows/F13.md. The note was not downloaded.'

const VOICE_UNAVAILABLE_ES: Readonly<Record<TranscriberUnavailable, string>> = {
  not_configured: `🎙️ Las notas de voz están desactivadas. Para activarlas instala whisper.cpp (whisper-cli) y ffmpeg en el PC, descarga un modelo ggml, define TELEGRAM_BRIDGE_WHISPER_MODEL con su ruta absoluta y reinicia la sesión. Todo se transcribe en el PC; nada sale a internet. ${VOICE_SETUP_ES}`,
  model_missing: `🎙️ Notas de voz: TELEGRAM_BRIDGE_WHISPER_MODEL no es la ruta absoluta de un archivo que exista. Corrígela y reinicia la sesión. ${VOICE_SETUP_ES}`,
  whisper_missing: `🎙️ Notas de voz: no se encontró whisper-cli. Instala whisper.cpp o define TELEGRAM_BRIDGE_WHISPER con la ruta absoluta del ejecutable, y reinicia la sesión. ${VOICE_SETUP_ES}`,
  ffmpeg_missing: `🎙️ Notas de voz: no se encontró ffmpeg, que convierte la nota (Opus) al WAV que lee whisper.cpp. Instálalo o define TELEGRAM_BRIDGE_FFMPEG con la ruta absoluta del ejecutable, y reinicia la sesión. ${VOICE_SETUP_ES}`,
}

const VOICE_UNAVAILABLE_EN: Readonly<Record<TranscriberUnavailable, string>> = {
  not_configured: `🎙️ Voice notes are off. To turn them on, install whisper.cpp (whisper-cli) and ffmpeg on the PC, download a ggml model, set TELEGRAM_BRIDGE_WHISPER_MODEL to its absolute path and restart the session. Everything is transcribed on the PC; nothing goes online. ${VOICE_SETUP_EN}`,
  model_missing: `🎙️ Voice notes: TELEGRAM_BRIDGE_WHISPER_MODEL is not the absolute path of an existing file. Fix it and restart the session. ${VOICE_SETUP_EN}`,
  whisper_missing: `🎙️ Voice notes: whisper-cli was not found. Install whisper.cpp or set TELEGRAM_BRIDGE_WHISPER to the absolute path of the executable, and restart the session. ${VOICE_SETUP_EN}`,
  ffmpeg_missing: `🎙️ Voice notes: ffmpeg was not found; it converts the note (Opus) to the WAV whisper.cpp reads. Install it or set TELEGRAM_BRIDGE_FFMPEG to the absolute path of the executable, and restart the session. ${VOICE_SETUP_EN}`,
}

function voiceRefusedEs(v: VoiceRefusalView): string {
  switch (v.reason) {
    case 'too_long':
      return `🎙️ La nota de voz dura más de ${v.maxSeconds} segundos (o no dice cuánto dura): no se descargó. Envía notas más cortas.`
    case 'too_large':
      return `🎙️ La nota de voz pesa más de ${v.maxMegabytes} MB: no se descargó.`
    case 'empty':
      return '🎙️ La nota de voz está vacía.'
    case 'not_ogg':
      return '🎙️ Ese archivo no es una nota de voz de Telegram (OGG): se descartó sin transcribir.'
    case 'busy':
      return '🎙️ Ya hay notas de voz en cola. Espera a que terminen y vuelve a enviarla.'
    case 'download_failed':
      return '🎙️ No se pudo descargar la nota de voz. Inténtalo de nuevo.'
    case 'conversion_failed':
      return '🎙️ ffmpeg no pudo leer la nota de voz. Se borró sin transcribir.'
    case 'transcription_failed':
      return '🎙️ whisper.cpp no pudo transcribir la nota. Revisa el modelo y el log. El audio se borró.'
    case 'timeout':
      return '🎙️ La transcripción tardó demasiado y se detuvo. Prueba un modelo más pequeño. El audio se borró.'
    case 'output_too_large':
      return '🎙️ La transcripción produjo demasiado texto y se descartó. El audio se borró.'
    case 'nothing_heard':
      return '🎙️ No se entendió nada en la nota de voz. El audio se borró.'
    case 'text_too_long':
      return '🎙️ La transcripción no cabe en un mensaje, así que no se puede mostrar entera para confirmarla. Se descartó: envía notas más cortas.'
    case 'contains_secret':
      return '🎙️ La transcripción contiene algo parecido a un secreto. Como el chat lo censuraría, no podrías ver exactamente lo que se enviaría: se descartó. Escríbelo en el PC.'
    case 'not_shown':
      return '🎙️ No se pudo mostrar la transcripción. Se descartó.'
  }
}

function voiceRefusedEn(v: VoiceRefusalView): string {
  switch (v.reason) {
    case 'too_long':
      return `🎙️ The voice note is longer than ${v.maxSeconds} seconds (or does not say how long it is): it was not downloaded. Send shorter notes.`
    case 'too_large':
      return `🎙️ The voice note is larger than ${v.maxMegabytes} MB: it was not downloaded.`
    case 'empty':
      return '🎙️ The voice note is empty.'
    case 'not_ogg':
      return '🎙️ That file is not a Telegram voice note (OGG): it was discarded without transcribing.'
    case 'busy':
      return '🎙️ Voice notes are already queued. Wait for them to finish and send it again.'
    case 'download_failed':
      return '🎙️ The voice note could not be downloaded. Try again.'
    case 'conversion_failed':
      return '🎙️ ffmpeg could not read the voice note. It was deleted without transcribing.'
    case 'transcription_failed':
      return '🎙️ whisper.cpp could not transcribe the note. Check the model and the log. The audio was deleted.'
    case 'timeout':
      return '🎙️ The transcription took too long and was stopped. Try a smaller model. The audio was deleted.'
    case 'output_too_large':
      return '🎙️ The transcription produced too much text and was discarded. The audio was deleted.'
    case 'nothing_heard':
      return '🎙️ Nothing could be made out in the voice note. The audio was deleted.'
    case 'text_too_long':
      return '🎙️ The transcript does not fit one message, so it cannot be shown whole for you to confirm. It was discarded: send shorter notes.'
    case 'contains_secret':
      return '🎙️ The transcript contains something that looks like a secret. The chat would redact it, so you could not see exactly what would be sent: it was discarded. Type it on the PC.'
    case 'not_shown':
      return '🎙️ The transcript could not be shown. It was discarded.'
  }
}

const VOICE_FEEDBACK_ES: Readonly<Record<VoiceTapOutcome, string>> = {
  sent: 'Enviado a Claude.',
  discarded: 'Descartado: no se envió nada.',
  braked: 'El freno está activo: no se envía nada. Envía /resume y vuelve a tocar Enviar.',
  already_resolved: 'Esa transcripción ya se resolvió.',
  expired: 'Esa transcripción ya venció.',
  not_found: 'Esa transcripción ya no existe.',
  not_allowed: 'No autorizado.',
}

const VOICE_FEEDBACK_EN: Readonly<Record<VoiceTapOutcome, string>> = {
  sent: 'Sent to Claude.',
  discarded: 'Discarded: nothing was sent.',
  braked: 'The brake is engaged: nothing is sent. Send /resume, then tap Send again.',
  already_resolved: 'That transcript was already resolved.',
  expired: 'That transcript has expired.',
  not_found: 'That transcript no longer exists.',
  not_allowed: 'Not authorized.',
}

/** The proposed lines as the file will hold them, one bullet each. */
function memoryLines(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

const BRAKE_SOURCE_ES = { telegram: ' desde Telegram', terminal: ' desde la terminal', unknown: '' }
const BRAKE_SOURCE_EN = { telegram: ' from Telegram', terminal: ' from the terminal', unknown: '' }

const PERMISSION_FEEDBACK_ES: Readonly<Record<PermissionOutcome, string>> = {
  approved: 'Aprobado.',
  denied: 'Denegado.',
  confirmation_requested: 'Riesgo alto: confirma la aprobación con el botón.',
  confirmation_cancelled: 'Aprobación cancelada; la solicitud sigue pendiente.',
  confirmation_expired: 'Se acabó el tiempo para confirmar. Vuelve a pulsar Aprobar.',
  use_button:
    'Riesgo alto: para aprobar usa los botones de la solicitud (Aprobar y luego Confirmar).',
  already_resolved: 'Esa solicitud ya se resolvió.',
  expired: 'Esa solicitud ya venció.',
  not_found: 'Esa solicitud ya no existe.',
  not_allowed: 'No autorizado.',
  invalid: 'Esa acción ya no aplica a la solicitud.',
  delivery_failed:
    'No se pudo enviar la respuesta a Claude Code. Inténtalo de nuevo o responde en la terminal.',
  braked: 'El freno está activo: no se aprueba nada. Envía /resume primero.',
}

const PERMISSION_FEEDBACK_EN: Readonly<Record<PermissionOutcome, string>> = {
  approved: 'Approved.',
  denied: 'Denied.',
  confirmation_requested: 'High risk: confirm the approval with the button.',
  confirmation_cancelled: 'Approval cancelled; the request is still pending.',
  confirmation_expired: 'The time to confirm ran out. Tap Approve again.',
  use_button: 'High risk: to approve, use the buttons on the request (Approve, then Confirm).',
  already_resolved: 'That request was already resolved.',
  expired: 'That request has expired.',
  not_found: 'That request no longer exists.',
  not_allowed: 'Not authorized.',
  invalid: 'That action no longer applies to the request.',
  delivery_failed:
    'The answer could not be sent to Claude Code. Try again or answer at the terminal.',
  braked: 'The brake is engaged: nothing can be approved. Send /resume first.',
}

const es: Messages = {
  pairingClaimedReply:
    'Código recibido. Confirma el emparejamiento en la terminal de tu PC para continuar.',
  startGreeting:
    'Puente conectado. Lo que escribas aquí llega a tu sesión de Claude Code. /help muestra los comandos.',
  help: (commands) =>
    `Comandos:\n${commandList(commands)}\n\nCualquier otro texto, incluidos otros /comandos, se envía a Claude.`,
  status: (v) =>
    lines(
      `Bot: ${v.botUsername === undefined ? 'desconocido' : `@${v.botUsername}`}`,
      `Emparejado desde: ${v.pairedSince ?? 'desconocido'}`,
      `Conexión MCP con Claude Code: ${v.sessionConnected ? 'abierta' : 'cerrada'}`,
      `Permisos pendientes: ${v.pendingPermissions}`,
      v.brake.engaged
        ? `Freno: ACTIVO desde ${v.brake.since ?? 'desconocido'} (/resume lo retira)`
        : 'Freno: no activo',
      captureLine(
        'Capturas',
        'ninguna (/shot explica qué instalar)',
        CAPTURE_KIND_ES,
        v.captureKinds,
      ),
      inboxLine((files, mb) => `Archivos recibidos guardados: ${files} (${mb} MB)`, v.inbox),
      gitLineEs(v.git),
      'No es posible saber desde aquí si la sesión cargó este canal ni si Claude está ocupado.',
    ),
  commandStartDescription: 'comprueba que el puente está conectado',
  commandHelpDescription: 'muestra esta ayuda',
  commandStatusDescription: 'estado del puente',
  commandStopDescription: 'botón de pánico: frena a Claude y deniega los permisos pendientes',
  commandResumeDescription: 'retira el freno de /stop',
  slowDown: 'Vas muy rápido: los mensajes de más se descartaron. Espera unos segundos.',
  staleMessagesIgnored:
    'Ignoré lo que enviaste antes de que empezara esta sesión de Claude Code. Vuelve a enviar lo que aún necesites.',
  onlyTextSupported:
    'Por ahora solo se admiten texto, fotos y archivos. Ese mensaje no se envió a Claude.',
  queued: 'Claude está ocupado: tu mensaje quedó en cola y lo verá al terminar.',
  deliveryFailed: 'No se pudo entregar el mensaje a la sesión de Claude Code.',
  messageTooLong: (max) =>
    `Mensaje demasiado largo: no se envió a la sesión. El límite es ${max} caracteres; divídelo en partes.`,

  permissionPrompt: (v) =>
    [
      '🔐 Claude pide permiso',
      `Herramienta: ${v.toolName}`,
      v.risk === 'high' ? 'Riesgo: ALTO ⚠️ (aprobar requiere un segundo toque)' : 'Riesgo: bajo',
      '',
      v.description,
      '',
      v.inputPreview,
      '',
      v.risk === 'high'
        ? `Solicitud ${v.requestId}. Sin botones, responde "no ${v.requestId}" para denegar; aprobar solo con los botones.`
        : `Solicitud ${v.requestId}. Sin botones, responde "si ${v.requestId}" o "no ${v.requestId}".`,
    ].join('\n'),
  permissionDetailsAbove: '(La descripción y la entrada completas están en el mensaje anterior.)',
  permissionDetails: (v) =>
    [
      `🔐 Solicitud ${v.requestId} (${v.toolName}), completa:`,
      '',
      v.description,
      '',
      v.inputPreview,
    ].join('\n'),
  permissionHidden: (count) =>
    `⚠️ ${count} caracteres sin mostrar: trátalo como riesgo alto y revisa la terminal si dudas.`,
  permissionAwaitingConfirmation: (seconds) =>
    `⚠️ Riesgo alto: pulsa "Confirmar aprobación" en los próximos ${seconds} s.`,
  permissionApproved: (d) => `✅ Aprobado por ${d.who} (${d.at})`,
  permissionDenied: (d) => `❌ Denegado por ${d.who} (${d.at})`,
  permissionDeniedByStop: (d) => `🛑 Denegado por /stop de ${d.who} (${d.at})`,
  permissionExpired: '⌛ Venció sin respuesta. Si sigue abierto, responde en la terminal.',
  permissionResolvedLocally: '🖥️ Respondido en la terminal.',
  permissionButtons: {
    approve: '✅ Aprobar',
    deny: '❌ Denegar',
    confirm: '⚠️ Confirmar aprobación',
    cancel: 'Cancelar',
  },
  permissionFeedback: (outcome) => PERMISSION_FEEDBACK_ES[outcome],

  noticeFinished: (v) =>
    notice(`✅ Claude terminó${v.project === undefined ? '' : ` en ${v.project}`}.`, v),
  noticeAttention: (v) =>
    notice(
      `🔔 Claude necesita tu respuesta${v.project === undefined ? '' : ` en ${v.project}`}.`,
      v,
    ),

  stopReport: (v) =>
    v.brake === 'already_engaged'
      ? lines(
          `🛑 El freno ya estaba activo (desde ${v.since ?? 'desconocido'}).`,
          v.denied > 0 ? `Se denegaron ${v.denied} solicitudes de permiso pendientes.` : undefined,
          'Envía /resume para retirarlo.',
        )
      : lines(
          '🛑 Freno activado: Claude no puede usar ninguna herramienta hasta /resume.',
          v.denied === 0
            ? 'No había solicitudes de permiso pendientes.'
            : `Se denegaron ${v.denied} solicitudes de permiso pendientes.`,
          INTERRUPT_ES[v.interrupt],
          'Envía /resume para retirarlo.',
        ),
  resumeReleased:
    '▶️ Freno retirado. Claude puede volver a usar herramientas; tus mensajes vuelven a llegar a la sesión.',
  resumeNotEngaged: 'El freno no estaba activo.',
  brakeHeldMessage:
    '🛑 El freno está activo: este mensaje no se envió a Claude. Envía /resume primero.',

  commandShotDescription: 'captura la pantalla; /shot <url> captura una página web',
  shotCapturing: '📸 Capturando…',
  shotCaption: (v) =>
    lines(
      v.kind === 'screen' ? '📸 Pantalla completa' : `📸 ${v.url}`,
      '⚠️ Las imágenes no pasan por la censura de secretos: revisa antes de reenviarlas.',
    ),
  shotProblem: (v) => {
    switch (v.problem) {
      case 'busy':
        return 'Ya hay una captura en curso. Inténtalo en unos segundos.'
      case 'invalid_url':
        return 'Esa dirección no se puede capturar: solo http:// o https://, sin usuario ni contraseña (por ejemplo /shot localhost:3000).'
      case 'too_large':
        return `La captura pesa unos ${v.megabytes} MB, más de lo que Telegram admite (50 MB). No se envió.`
      case 'failed':
        return 'La captura falló. Los detalles quedan en el registro del canal.'
      case 'unavailable':
        return lines(
          `${v.kind === 'screen' ? 'Capturar la pantalla' : 'Capturar páginas web'} no está disponible aquí${v.reason === undefined ? '.' : `: ${SHOT_UNAVAILABLE_ES[v.reason]}.`}`,
          remedies('Para habilitarlo instala o configura:', v.remedies),
        )
    }
  },

  choicePrompt: (question) => `❓ Claude pregunta:\n\n${question}`,
  choiceQuestionAbove: '❓ Claude pregunta (la pregunta completa está en el mensaje anterior).',
  choiceOtherButton: 'Otra…',
  choiceStatus: (v) => {
    switch (v.status) {
      case 'answered':
        return `✅ Elegido: ${v.label} (${v.who}, ${v.at})`
      case 'answered_with_text':
        return `✅ Respondido con un mensaje (${v.who}, ${v.at})`
      case 'awaiting_text':
        return '✍️ Escribe tu respuesta en el próximo mensaje.'
      case 'expired':
        return '⌛ Venció sin respuesta.'
      case 'cancelled':
        return '🚫 Cancelada: la sesión que preguntó ya terminó.'
    }
  },
  choiceFeedback: (outcome) => CHOICE_FEEDBACK_ES[outcome],

  commandSkillsDescription: 'lista las skills de la sesión como botones',
  skillsMenu: (v) =>
    lines(
      `🧩 Skills${v.pages > 1 ? ` (página ${v.page + 1} de ${v.pages})` : ''}:`,
      '',
      skillLines(v),
      '',
      'Pulsa una para pedirle a Claude que la use.',
      v.projectKnown
        ? undefined
        : 'No se conoce el directorio del proyecto: solo se listan tus skills personales.',
    ),
  skillsNone: (projectKnown) =>
    projectKnown
      ? 'No se encontraron skills (ni en .claude/skills del proyecto ni en las personales).'
      : 'No se conoce el directorio del proyecto (CLAUDE_PROJECT_DIR no está definido) y no hay skills personales.',
  skillsPageButtons: { previous: '◀ Anterior', next: 'Siguiente ▶' },
  skillFeedback: (outcome) =>
    outcome === 'sent'
      ? 'Enviado a Claude.'
      : outcome === 'braked'
        ? 'El freno está activo: no se envió nada a Claude. Envía /resume primero.'
        : 'Esa skill ya no está. Envía /skills de nuevo.',

  attachmentRefused: (v) =>
    lines(
      `📎 Ese archivo no se envió a Claude: ${ATTACHMENT_REASON_ES[v.reason]}.`,
      v.reason === 'too_large' ? `El límite es ${v.maxMegabytes} MB.` : undefined,
      v.reason === 'type_not_allowed' || v.reason === 'type_mismatch'
        ? `Se admiten fotos y archivos ${v.allowed.join(', ')} (los de texto, en UTF-8).`
        : undefined,
    ),

  commandDiffDescription:
    'envía los cambios sin commit como archivo .diff (/diff <ruta> para una sola ruta)',
  diffProblem: (v) => {
    switch (v.problem) {
      case 'not_a_repo':
        return 'El directorio del proyecto no es un repositorio git (CLAUDE_PROJECT_DIR, o el directorio donde arrancó Claude Code).'
      case 'git_missing':
        return 'git no está instalado (o no está en el PATH) para el puente.'
      case 'unsafe_config':
        return 'La configuración del repositorio define un filtro que el puente no puede desactivar con seguridad; /diff no está disponible aquí.'
      case 'busy':
        return 'Ya hay un /diff en curso.'
      case 'failed':
        return 'git falló; el detalle está en el log del canal.'
      case 'invalid_path':
        return `Esa ruta no se acepta: ${DIFF_PATH_PROBLEM_ES[v.reason]}. Usa una ruta relativa dentro del proyecto, como src/app.ts.`
      case 'no_changes':
        return `✔️ No hay cambios${v.pathFilter === undefined ? '' : ` en ${shown(v.pathFilter)}`}${v.branch === undefined ? '' : ` (rama ${shown(v.branch)})`}.`
    }
  },
  diffSummary: (v) =>
    lines(
      `📝 Cambios${v.project === undefined ? '' : ` en ${shown(v.project)}`} (${branchEs(v.status)})`,
      v.pathFilter === undefined ? undefined : `Solo: ${shown(v.pathFilter)}`,
      gitCountsEs(v.status),
      `${v.files} archivos con cambios, +${v.insertions} −${v.deletions}${v.binary > 0 ? ` (${v.binary} binarios, sin contenido)` : ''}`,
      'Los secretos reconocibles se censuran en el archivo; los que no tienen un formato conocido pueden pasar.',
    ),
  diffDocument: {
    staged: '# Cambios preparados (git diff --cached)',
    unstaged: '# Cambios sin preparar (git diff)',
    untracked: '# Archivos sin seguimiento (no están en el diff)',
    cutWhileReading: (mb) =>
      `# … cortado: esta parte supera ${mb} MB; solo se muestran las líneas completas hasta ahí`,
    cutToFit: (mb) => `# … cortado a ${mb} MB (después de censurar)`,
  },
  gitActionsPrompt:
    'Pídele a Claude que actúe sobre estos cambios. Cada botón envía una instrucción fija a la sesión; Claude igual pide permiso antes de ejecutar nada.',
  gitActionButtons: {
    commit: '✅ Commit',
    revert: '↩️ Revertir',
    pr: '🔀 Abrir PR',
    confirmRevert: '⚠️ Confirmar revertir',
    cancel: 'Cancelar',
  },
  gitRevertConfirm:
    '⚠️ Revertir descarta todos los cambios sin commit de los archivos con seguimiento. Los archivos sin seguimiento se conservan y se listan. ¿Confirmas?',
  gitRevertCancelled: 'Revertir cancelado. Envía /diff de nuevo para tener botones.',
  gitActionSent: (action) =>
    `➡️ Enviado a Claude: ${GIT_ACTION_ES[action]}. Aprueba o deniega sus herramientas como siempre.`,
  gitInstruction: (action) => GIT_INSTRUCTION_ES[action],
  gitTapFeedback: (outcome) => GIT_TAP_ES[outcome],

  chartCaption: (caption) =>
    lines(
      caption === undefined || caption === '' ? '📊 Gráfica' : `📊 ${caption}`,
      '⚠️ Los secretos reconocibles en los textos de la gráfica se censuraron antes de dibujarla; el resto de la imagen no pasa por la censura.',
    ),

  commandWrapDescription: 'pide a Claude un resumen de la sesión y propuestas para CLAUDE.md',
  wrapInstruction: WRAP_INSTRUCTION_ES,
  wrapSent:
    '🧾 Le pedí a Claude que resuma la sesión. El resumen se guarda en docs/sessions/ y las líneas para CLAUDE.md llegan con botones: nada entra sin tu aprobación.',
  summarySaved: (v) =>
    v.document === undefined
      ? `🧾 Resumen guardado en ${shown(v.path, 200)} (archivo local, sin censura). Tiene ${v.length} caracteres, demasiados para el chat: ábrelo en el PC.`
      : `🧾 Resumen guardado en ${shown(v.path, 200)} (archivo local, sin censura):\n\n${v.document}`,
  memoryPrompt: (memory) =>
    lines(
      '🧠 Claude propone agregar estas líneas a CLAUDE.md (bajo "## Session notes"):',
      '',
      memoryLines(memory),
      '',
      'Aprobar escribe exactamente estas líneas. Rechazar no escribe nada.',
    ),
  memoryButtons: { approve: '✅ Aprobar', reject: '❌ Rechazar' },
  memoryStatus: (v) => {
    switch (v.status) {
      case 'approved':
        return `✅ Aprobado por ${v.who} (${v.at}): escrito en ${shown(v.file, 200)}.${MEMORY_NOTICE_ES[v.notice]}`
      case 'rejected':
        return `❌ Rechazado por ${v.who} (${v.at}): no se escribió nada.${MEMORY_NOTICE_ES[v.notice]}`
      case 'write_failed':
        return '⚠️ No se pudo escribir CLAUDE.md. Puedes volver a intentarlo.'
      case 'expired':
        return '⌛ Venció sin respuesta: no se escribió nada.'
      case 'cancelled':
        return '🚫 Cancelada: la sesión que la propuso ya terminó. No se escribió nada.'
    }
  },
  memoryFeedback: (outcome) => MEMORY_FEEDBACK_ES[outcome],
  memorySessionOutcome: (v) =>
    v.outcome === 'approved'
      ? `El dueño aprobó la propuesta de memoria ${v.proposalId}: sus ${v.lines} líneas se agregaron a ${v.file} bajo "## Session notes". No las vuelvas a escribir.`
      : `El dueño rechazó la propuesta de memoria ${v.proposalId}: no se escribió nada en ${v.file}. No la escribas por tu cuenta.`,

  voiceUnavailable: (reason) => VOICE_UNAVAILABLE_ES[reason],
  voiceRefused: voiceRefusedEs,
  voicePrompt: (v) =>
    lines(
      `🎙️ Transcripción de tu nota de voz (${v.seconds} s):`,
      '',
      v.text,
      '',
      'Enviar pasa exactamente este texto a Claude, como si lo hubieras escrito. Revisa que se entendió bien. Descartar no envía nada.',
    ),
  voiceButtons: { send: '✅ Enviar', discard: '🗑️ Descartar' },
  voiceStatus: (v) => {
    switch (v.status) {
      case 'sent':
        return `✅ Enviado a Claude por ${v.who} (${v.at}).`
      case 'discarded':
        return `🗑️ Descartado por ${v.who} (${v.at}): no se envió nada.`
      case 'expired':
        return '⌛ Venció sin respuesta: no se envió nada.'
      case 'cancelled':
        return '🚫 Cancelada: la sesión que la transcribió ya terminó. No se envió nada.'
    }
  },
  voiceFeedback: (outcome) => VOICE_FEEDBACK_ES[outcome],

  commandPinDescription: 'fija un mensaje de estado que sigue a la sesión',
  commandUnpinDescription: 'quita el mensaje de estado fijado',
  pinnedStatus: (v) =>
    lines(
      `📌 Claude Code${v.project === undefined ? '' : ` · ${shown(v.project)}`}`,
      `Estado: ${pinnedStateEs(v)}`,
      v.activity === undefined
        ? undefined
        : `Última herramienta: ${v.activity.tool}${v.activity.detail === undefined ? '' : ` · ${v.activity.detail}`}`,
      v.pendingPermissions + v.pendingChoices === 0
        ? undefined
        : `Esperándote: ${v.pendingPermissions} permisos, ${v.pendingChoices} preguntas`,
      v.lastFinished === undefined ? undefined : `Última vez que terminó: ${v.lastFinished}`,
    ),
  pinFailed: 'No se pudo enviar el mensaje de estado.',
  pinNotPinned: 'El mensaje de estado se envió, pero no se pudo fijar; igual se actualiza.',
  unpinDone: 'Mensaje de estado desfijado; ya no se actualiza.',
  unpinNothing: 'No hay mensaje de estado que quitar.',

  brakeStopReason: (v) =>
    v.source === undefined
      ? `telegram-bridge: el freno está activo, pero su archivo no se puede leer (${v.flagPath}). Claude se detuvo. Para retirarlo ejecuta "${CLI_INVOCATION} resume" o borra ese archivo.`
      : lines(
          `telegram-bridge: freno activado${BRAKE_SOURCE_ES[v.source]}${v.since === undefined ? '' : ` (${v.since})`}. Claude se detuvo.`,
          v.reason === undefined ? undefined : `Motivo: ${v.reason}`,
          `Para retirarlo envía /resume en Telegram o ejecuta "${CLI_INVOCATION} resume".`,
        ),
  brakeToolDenied:
    'The telegram-bridge brake is engaged: the owner asked to stop. Do not retry; wait for the user.',

  cliStopEngaged:
    'Freno activado. Claude se detendrá en su próxima herramienta. Las solicitudes de permiso ya enviadas al chat no se pueden aprobar mientras dure el freno.',
  cliStopAlreadyEngaged: (since) => `El freno ya estaba activo (desde ${since ?? 'desconocido'}).`,
  cliResumeReleased: 'Freno retirado.',
  cliResumeNotEngaged: 'El freno no estaba activo.',

  usage: USAGE_ES,
  unknownCommand: 'Comando o argumentos no válidos.',
  unexpectedError: (detail) => `Error inesperado: ${detail}`,
  notConfigured: `El bot no está configurado. Ejecuta primero: ${CLI_INVOCATION} init`,
  invalidStateDir: (variable) =>
    `${variable} debe ser una ruta absoluta (o empezar con ~/). No se resuelve contra el directorio actual, porque el canal, este comando y los hooks corren en directorios distintos. Corrígela o quítala e inténtalo de nuevo.`,

  initTokenPrompt: 'Pega el token que te dio @BotFather (no se mostrará): ',
  initTokenEmpty: 'No se recibió ningún token.',
  initNeedsTerminal: `No hay una terminal interactiva. Usa: ${CLI_INVOCATION} init --token-stdin < archivo`,
  initStdinIsTerminal: `--token-stdin espera el token por una tubería, por ejemplo: ${CLI_INVOCATION} init --token-stdin < archivo`,
  initValidating: 'Validando el token con Telegram...',
  initInvalidToken: 'Telegram rechazó el token. Revísalo en @BotFather e inténtalo de nuevo.',
  initUnreachable: (detail) => `No se pudo contactar a Telegram (${detail}). Revisa tu conexión.`,
  initDone: (username) => `Listo: el bot @${username} quedó configurado.`,
  initEnvOverride:
    'Aviso: la variable TELEGRAM_BOT_TOKEN está definida y tiene prioridad sobre el token guardado.',
  initNextStep: `Siguiente paso: ${CLI_INVOCATION} pair`,

  pairScan: 'Escanea este código QR con tu teléfono, o abre el enlace:',
  pairLink: (link) => link,
  pairExpiresIn: (seconds) => `El código vence en ${seconds} segundos y sirve una sola vez.`,
  pairUsingChannel:
    'La sesión de Claude Code está recibiendo los mensajes del bot; esperando el código...',
  pairPollingHere: 'Esperando el código en Telegram...',
  pairAnotherInProgress: (pid) =>
    `Ya hay otro emparejamiento en curso (proceso ${pid}). Termínalo o espera a que venza.`,
  pairClaimedBy: (c) =>
    claimant(c, {
      header: 'Código recibido de:',
      id: 'Id de Telegram',
      name: 'Nombre',
      username: 'Usuario',
      none: '(ninguno)',
    }),
  pairConfirmPrompt: '¿Es tu cuenta? Solo esa cuenta podrá controlar este PC. [s/N] ',
  pairConfirmed: (c) => `Emparejado. ${who(c)} ya puede usar el bot.`,
  pairDeclined: 'Emparejamiento rechazado. Nadie obtuvo acceso.',
  pairExpired: 'El código venció sin confirmarse. Ejecuta pair de nuevo.',
  pairCancelled: 'El emparejamiento se canceló (demasiados intentos o fue reemplazado).',
  pairTokenRejected: `Telegram rechazó el token. Ejecuta ${CLI_INVOCATION} init de nuevo.`,
  pairPollingConflict:
    'Otro programa está leyendo los mensajes de este bot. Ciérralo e inténtalo de nuevo.',

  accessListEmpty: `No hay cuentas permitidas. Usa ${CLI_INVOCATION} pair para agregar una.`,
  accessListHeader: 'Cuentas permitidas:',
  accessListRow: (s, addedAt) => `  ${who(s)}, agregada el ${addedAt}`,
  accessRevoked: (id) => `Acceso retirado a ${id}.`,
  accessNotFound: (id) => `${id} no estaba en la lista de permitidos.`,
  accessInvalidId: 'El id debe ser el número de usuario de Telegram (solo dígitos).',
}

const en: Messages = {
  pairingClaimedReply: 'Code received. Confirm the pairing in the terminal on your PC to continue.',
  startGreeting:
    'Bridge connected. What you write here reaches your Claude Code session. /help lists the commands.',
  help: (commands) =>
    `Commands:\n${commandList(commands)}\n\nAny other text, other /commands included, goes to Claude.`,
  status: (v) =>
    lines(
      `Bot: ${v.botUsername === undefined ? 'unknown' : `@${v.botUsername}`}`,
      `Paired since: ${v.pairedSince ?? 'unknown'}`,
      `MCP connection to Claude Code: ${v.sessionConnected ? 'open' : 'closed'}`,
      `Pending permission requests: ${v.pendingPermissions}`,
      v.brake.engaged
        ? `Brake: ENGAGED since ${v.brake.since ?? 'unknown'} (/resume releases it)`
        : 'Brake: not engaged',
      captureLine(
        'Screenshots',
        'none (/shot says what to install)',
        CAPTURE_KIND_EN,
        v.captureKinds,
      ),
      inboxLine((files, mb) => `Received files kept: ${files} (${mb} MB)`, v.inbox),
      gitLineEn(v.git),
      'From here it cannot be known whether the session loaded this channel or whether Claude is busy.',
    ),
  commandStartDescription: 'check that the bridge is connected',
  commandHelpDescription: 'show this help',
  commandStatusDescription: 'bridge status',
  commandStopDescription: 'panic button: brakes Claude and denies pending permissions',
  commandResumeDescription: 'releases the /stop brake',
  slowDown: 'You are going too fast: the extra messages were dropped. Wait a few seconds.',
  staleMessagesIgnored:
    'I ignored what you sent before this Claude Code session started. Send again whatever you still need.',
  onlyTextSupported:
    'Only text, photos and files are supported for now. That message was not sent to Claude.',
  queued: 'Claude is busy: your message is queued and Claude will see it when done.',
  deliveryFailed: 'The message could not be delivered to the Claude Code session.',
  messageTooLong: (max) =>
    `Message too long: it was not sent to the session. The limit is ${max} characters; split it into parts.`,

  permissionPrompt: (v) =>
    [
      '🔐 Claude asks for permission',
      `Tool: ${v.toolName}`,
      v.risk === 'high' ? 'Risk: HIGH ⚠️ (approving needs a second tap)' : 'Risk: low',
      '',
      v.description,
      '',
      v.inputPreview,
      '',
      v.risk === 'high'
        ? `Request ${v.requestId}. Without buttons, reply "no ${v.requestId}" to deny; approving needs the buttons.`
        : `Request ${v.requestId}. Without buttons, reply "yes ${v.requestId}" or "no ${v.requestId}".`,
    ].join('\n'),
  permissionDetailsAbove: '(The full description and input are in the message above.)',
  permissionDetails: (v) =>
    [
      `🔐 Request ${v.requestId} (${v.toolName}), in full:`,
      '',
      v.description,
      '',
      v.inputPreview,
    ].join('\n'),
  permissionHidden: (count) =>
    `⚠️ ${count} characters not shown: treat this as high risk and check the terminal if in doubt.`,
  permissionAwaitingConfirmation: (seconds) =>
    `⚠️ High risk: tap "Confirm approve" within ${seconds} s.`,
  permissionApproved: (d) => `✅ Approved by ${d.who} (${d.at})`,
  permissionDenied: (d) => `❌ Denied by ${d.who} (${d.at})`,
  permissionDeniedByStop: (d) => `🛑 Denied by /stop from ${d.who} (${d.at})`,
  permissionExpired: '⌛ Expired without an answer. If it is still open, answer at the terminal.',
  permissionResolvedLocally: '🖥️ Answered at the terminal.',
  permissionButtons: {
    approve: '✅ Approve',
    deny: '❌ Deny',
    confirm: '⚠️ Confirm approve',
    cancel: 'Cancel',
  },
  permissionFeedback: (outcome) => PERMISSION_FEEDBACK_EN[outcome],

  noticeFinished: (v) =>
    notice(`✅ Claude finished${v.project === undefined ? '' : ` in ${v.project}`}.`, v),
  noticeAttention: (v) =>
    notice(`🔔 Claude needs your answer${v.project === undefined ? '' : ` in ${v.project}`}.`, v),

  stopReport: (v) =>
    v.brake === 'already_engaged'
      ? lines(
          `🛑 The brake was already engaged (since ${v.since ?? 'unknown'}).`,
          v.denied > 0 ? `Denied ${v.denied} pending permission requests.` : undefined,
          'Send /resume to release it.',
        )
      : lines(
          '🛑 Brake engaged: Claude cannot run any tool until /resume.',
          v.denied === 0
            ? 'There were no pending permission requests.'
            : `Denied ${v.denied} pending permission requests.`,
          INTERRUPT_EN[v.interrupt],
          'Send /resume to release it.',
        ),
  resumeReleased:
    '▶️ Brake released. Claude can use tools again; your messages reach the session again.',
  resumeNotEngaged: 'The brake was not engaged.',
  brakeHeldMessage:
    '🛑 The brake is engaged: this message was not sent to Claude. Send /resume first.',

  commandShotDescription: 'captures the screen; /shot <url> captures a web page',
  shotCapturing: '📸 Capturing…',
  shotCaption: (v) =>
    lines(
      v.kind === 'screen' ? '📸 Full screen' : `📸 ${v.url}`,
      '⚠️ Images do not go through secret redaction: check before forwarding them.',
    ),
  shotProblem: (v) => {
    switch (v.problem) {
      case 'busy':
        return 'A capture is already running. Try again in a few seconds.'
      case 'invalid_url':
        return 'That address cannot be captured: only http:// or https://, without a user or password (for example /shot localhost:3000).'
      case 'too_large':
        return `The capture is about ${v.megabytes} MB, more than Telegram accepts (50 MB). It was not sent.`
      case 'failed':
        return 'The capture failed. The details are in the channel log.'
      case 'unavailable':
        return lines(
          `${v.kind === 'screen' ? 'Capturing the screen' : 'Capturing web pages'} is not available here${v.reason === undefined ? '.' : `: ${SHOT_UNAVAILABLE_EN[v.reason]}.`}`,
          remedies('To enable it, install or set:', v.remedies),
        )
    }
  },

  choicePrompt: (question) => `❓ Claude asks:\n\n${question}`,
  choiceQuestionAbove: '❓ Claude asks (the full question is in the message above).',
  choiceOtherButton: 'Other…',
  choiceStatus: (v) => {
    switch (v.status) {
      case 'answered':
        return `✅ Chosen: ${v.label} (${v.who}, ${v.at})`
      case 'answered_with_text':
        return `✅ Answered with a message (${v.who}, ${v.at})`
      case 'awaiting_text':
        return '✍️ Write your answer as your next message.'
      case 'expired':
        return '⌛ Expired without an answer.'
      case 'cancelled':
        return '🚫 Cancelled: the session that asked has ended.'
    }
  },
  choiceFeedback: (outcome) => CHOICE_FEEDBACK_EN[outcome],

  commandSkillsDescription: "lists the session's skills as buttons",
  skillsMenu: (v) =>
    lines(
      `🧩 Skills${v.pages > 1 ? ` (page ${v.page + 1} of ${v.pages})` : ''}:`,
      '',
      skillLines(v),
      '',
      'Tap one to ask Claude to use it.',
      v.projectKnown
        ? undefined
        : 'The project directory is not known: only your personal skills are listed.',
    ),
  skillsNone: (projectKnown) =>
    projectKnown
      ? "No skills were found (neither in the project's .claude/skills nor personal ones)."
      : 'The project directory is not known (CLAUDE_PROJECT_DIR is not set) and there are no personal skills.',
  skillsPageButtons: { previous: '◀ Previous', next: 'Next ▶' },
  skillFeedback: (outcome) =>
    outcome === 'sent'
      ? 'Sent to Claude.'
      : outcome === 'braked'
        ? 'The brake is engaged: nothing was sent to Claude. Send /resume first.'
        : 'That skill is gone. Send /skills again.',

  attachmentRefused: (v) =>
    lines(
      `📎 That file was not sent to Claude: ${ATTACHMENT_REASON_EN[v.reason]}.`,
      v.reason === 'too_large' ? `The limit is ${v.maxMegabytes} MB.` : undefined,
      v.reason === 'type_not_allowed' || v.reason === 'type_mismatch'
        ? `Accepted: photos and ${v.allowed.join(', ')} files (text ones in UTF-8).`
        : undefined,
    ),

  commandDiffDescription:
    'sends the uncommitted changes as a .diff file (/diff <path> for one path)',
  diffProblem: (v) => {
    switch (v.problem) {
      case 'not_a_repo':
        return 'The project directory is not a git work tree (CLAUDE_PROJECT_DIR, or the directory Claude Code started in).'
      case 'git_missing':
        return 'git is not installed (or not on PATH) for the bridge.'
      case 'unsafe_config':
        return 'The repository configuration defines a filter the bridge cannot disable safely; /diff is not available here.'
      case 'busy':
        return 'A /diff is already running.'
      case 'failed':
        return 'git failed; the details are in the channel log.'
      case 'invalid_path':
        return `That path is not accepted: ${DIFF_PATH_PROBLEM_EN[v.reason]}. Use a relative path inside the project, such as src/app.ts.`
      case 'no_changes':
        return `✔️ No changes${v.pathFilter === undefined ? '' : ` in ${shown(v.pathFilter)}`}${v.branch === undefined ? '' : ` (branch ${shown(v.branch)})`}.`
    }
  },
  diffSummary: (v) =>
    lines(
      `📝 Changes${v.project === undefined ? '' : ` in ${shown(v.project)}`} (${branchEn(v.status)})`,
      v.pathFilter === undefined ? undefined : `Only: ${shown(v.pathFilter)}`,
      gitCountsEn(v.status),
      `${v.files} files changed, +${v.insertions} −${v.deletions}${v.binary > 0 ? ` (${v.binary} binary, no content)` : ''}`,
      'Recognizable secrets are redacted in the file; ones without a known shape can get through.',
    ),
  diffDocument: {
    staged: '# Staged changes (git diff --cached)',
    unstaged: '# Unstaged changes (git diff)',
    untracked: '# Untracked files (not in the diff)',
    cutWhileReading: (mb) =>
      `# … cut: this part is over ${mb} MB; only the whole lines up to there are shown`,
    cutToFit: (mb) => `# … cut to ${mb} MB (after redaction)`,
  },
  gitActionsPrompt:
    'Ask Claude to act on these changes. Each button sends a fixed instruction to the session; Claude still asks for permission before running anything.',
  gitActionButtons: {
    commit: '✅ Commit',
    revert: '↩️ Revert',
    pr: '🔀 Open PR',
    confirmRevert: '⚠️ Confirm revert',
    cancel: 'Cancel',
  },
  gitRevertConfirm:
    '⚠️ Revert discards every uncommitted change to tracked files. Untracked files are kept and listed. Confirm?',
  gitRevertCancelled: 'Revert cancelled. Send /diff again for new buttons.',
  gitActionSent: (action) =>
    `➡️ Sent to Claude: ${GIT_ACTION_EN[action]}. Approve or deny its tool calls as usual.`,
  gitInstruction: (action) => GIT_INSTRUCTION_EN[action],
  gitTapFeedback: (outcome) => GIT_TAP_EN[outcome],

  chartCaption: (caption) =>
    lines(
      caption === undefined || caption === '' ? '📊 Chart' : `📊 ${caption}`,
      "⚠️ Recognizable secrets in the chart's text were redacted before drawing; the rest of the image does not go through redaction.",
    ),

  commandWrapDescription: 'asks Claude for a session summary and proposals for CLAUDE.md',
  wrapInstruction: WRAP_INSTRUCTION_EN,
  wrapSent:
    '🧾 Asked Claude to summarize the session. The summary is saved in docs/sessions/ and lines for CLAUDE.md arrive with buttons: nothing goes in without your approval.',
  summarySaved: (v) =>
    v.document === undefined
      ? `🧾 Summary saved to ${shown(v.path, 200)} (local file, not redacted). It has ${v.length} characters, too many for the chat: open it on the PC.`
      : `🧾 Summary saved to ${shown(v.path, 200)} (local file, not redacted):\n\n${v.document}`,
  memoryPrompt: (memory) =>
    lines(
      '🧠 Claude proposes adding these lines to CLAUDE.md (under "## Session notes"):',
      '',
      memoryLines(memory),
      '',
      'Approve writes exactly these lines. Reject writes nothing.',
    ),
  memoryButtons: { approve: '✅ Approve', reject: '❌ Reject' },
  memoryStatus: (v) => {
    switch (v.status) {
      case 'approved':
        return `✅ Approved by ${v.who} (${v.at}): written to ${shown(v.file, 200)}.${MEMORY_NOTICE_EN[v.notice]}`
      case 'rejected':
        return `❌ Rejected by ${v.who} (${v.at}): nothing was written.${MEMORY_NOTICE_EN[v.notice]}`
      case 'write_failed':
        return '⚠️ CLAUDE.md could not be written. You can try again.'
      case 'expired':
        return '⌛ Expired without an answer: nothing was written.'
      case 'cancelled':
        return '🚫 Cancelled: the session that proposed it has ended. Nothing was written.'
    }
  },
  memoryFeedback: (outcome) => MEMORY_FEEDBACK_EN[outcome],
  memorySessionOutcome: (v) =>
    v.outcome === 'approved'
      ? `The owner approved memory proposal ${v.proposalId}: its ${v.lines} lines were added to ${v.file} under "## Session notes". Do not write them again.`
      : `The owner rejected memory proposal ${v.proposalId}: nothing was written to ${v.file}. Do not write it yourself.`,

  voiceUnavailable: (reason) => VOICE_UNAVAILABLE_EN[reason],
  voiceRefused: voiceRefusedEn,
  voicePrompt: (v) =>
    lines(
      `🎙️ Transcript of your voice note (${v.seconds} s):`,
      '',
      v.text,
      '',
      'Send passes exactly this text to Claude, as if you had typed it. Check it was understood correctly. Discard sends nothing.',
    ),
  voiceButtons: { send: '✅ Send', discard: '🗑️ Discard' },
  voiceStatus: (v) => {
    switch (v.status) {
      case 'sent':
        return `✅ Sent to Claude by ${v.who} (${v.at}).`
      case 'discarded':
        return `🗑️ Discarded by ${v.who} (${v.at}): nothing was sent.`
      case 'expired':
        return '⌛ Expired without an answer: nothing was sent.'
      case 'cancelled':
        return '🚫 Cancelled: the session that transcribed it has ended. Nothing was sent.'
    }
  },
  voiceFeedback: (outcome) => VOICE_FEEDBACK_EN[outcome],

  commandPinDescription: 'pins a status message that follows the session',
  commandUnpinDescription: 'removes the pinned status message',
  pinnedStatus: (v) =>
    lines(
      `📌 Claude Code${v.project === undefined ? '' : ` · ${shown(v.project)}`}`,
      `State: ${pinnedStateEn(v)}`,
      v.activity === undefined
        ? undefined
        : `Last tool: ${v.activity.tool}${v.activity.detail === undefined ? '' : ` · ${v.activity.detail}`}`,
      v.pendingPermissions + v.pendingChoices === 0
        ? undefined
        : `Waiting for you: ${v.pendingPermissions} permissions, ${v.pendingChoices} questions`,
      v.lastFinished === undefined ? undefined : `Last finished: ${v.lastFinished}`,
    ),
  pinFailed: 'The status message could not be sent.',
  pinNotPinned: 'The status message was sent but could not be pinned; it is still updated.',
  unpinDone: 'Status message unpinned; it is no longer updated.',
  unpinNothing: 'There is no status message to remove.',

  brakeStopReason: (v) =>
    v.source === undefined
      ? `telegram-bridge: the brake is engaged, but its file cannot be read (${v.flagPath}). Claude stopped. To release it run "${CLI_INVOCATION} resume" or delete that file.`
      : lines(
          `telegram-bridge: brake engaged${BRAKE_SOURCE_EN[v.source]}${v.since === undefined ? '' : ` (${v.since})`}. Claude stopped.`,
          v.reason === undefined ? undefined : `Reason: ${v.reason}`,
          `To release it send /resume in Telegram or run "${CLI_INVOCATION} resume".`,
        ),
  brakeToolDenied:
    'The telegram-bridge brake is engaged: the owner asked to stop. Do not retry; wait for the user.',

  cliStopEngaged:
    'Brake engaged. Claude will stop at its next tool call. Permission requests already sent to the chat cannot be approved while it lasts.',
  cliStopAlreadyEngaged: (since) => `The brake was already engaged (since ${since ?? 'unknown'}).`,
  cliResumeReleased: 'Brake released.',
  cliResumeNotEngaged: 'The brake was not engaged.',

  usage: USAGE_EN,
  unknownCommand: 'Invalid command or arguments.',
  unexpectedError: (detail) => `Unexpected error: ${detail}`,
  notConfigured: `The bot is not configured. Run first: ${CLI_INVOCATION} init`,
  invalidStateDir: (variable) =>
    `${variable} must be an absolute path (or start with ~/). It is not resolved against the current directory, because the channel, this command and the hooks run in different directories. Fix or unset it and try again.`,

  initTokenPrompt: 'Paste the token from @BotFather (it will not be shown): ',
  initTokenEmpty: 'No token was received.',
  initNeedsTerminal: `No interactive terminal. Use: ${CLI_INVOCATION} init --token-stdin < file`,
  initStdinIsTerminal: `--token-stdin expects the token on a pipe, for example: ${CLI_INVOCATION} init --token-stdin < file`,
  initValidating: 'Validating the token with Telegram...',
  initInvalidToken: 'Telegram rejected the token. Check it in @BotFather and try again.',
  initUnreachable: (detail) => `Could not reach Telegram (${detail}). Check your connection.`,
  initDone: (username) => `Done: the bot @${username} is configured.`,
  initEnvOverride:
    'Note: the TELEGRAM_BOT_TOKEN variable is set and takes precedence over the saved token.',
  initNextStep: `Next step: ${CLI_INVOCATION} pair`,

  pairScan: 'Scan this QR code with your phone, or open the link:',
  pairLink: (link) => link,
  pairExpiresIn: (seconds) => `The code expires in ${seconds} seconds and works once.`,
  pairUsingChannel:
    'The Claude Code session is receiving the bot messages; waiting for the code...',
  pairPollingHere: 'Waiting for the code on Telegram...',
  pairAnotherInProgress: (pid) =>
    `Another pairing is already running (process ${pid}). Finish it or wait for it to expire.`,
  pairClaimedBy: (c) =>
    claimant(c, {
      header: 'Code received from:',
      id: 'Telegram id',
      name: 'Name',
      username: 'Username',
      none: '(none)',
    }),
  pairConfirmPrompt: 'Is this your account? Only it will be able to control this PC. [y/N] ',
  pairConfirmed: (c) => `Paired. ${who(c)} can now use the bot.`,
  pairDeclined: 'Pairing declined. Nobody was given access.',
  pairExpired: 'The code expired without confirmation. Run pair again.',
  pairCancelled: 'The pairing was cancelled (too many attempts, or it was replaced).',
  pairTokenRejected: `Telegram rejected the token. Run ${CLI_INVOCATION} init again.`,
  pairPollingConflict: "Another program is reading this bot's messages. Close it and try again.",

  accessListEmpty: `No accounts are allowed. Use ${CLI_INVOCATION} pair to add one.`,
  accessListHeader: 'Allowed accounts:',
  accessListRow: (s, addedAt) => `  ${who(s)}, added on ${addedAt}`,
  accessRevoked: (id) => `Access removed for ${id}.`,
  accessNotFound: (id) => `${id} was not in the allowlist.`,
  accessInvalidId: 'The id must be the numeric Telegram user id (digits only).',
}

const CATALOG: Readonly<Record<Locale, Messages>> = { es, en }

export const LOCALE_ENV = 'TELEGRAM_BRIDGE_LOCALE'

/** Unset, blank or unknown values fall back to Spanish. */
export function parseLocale(raw: string | undefined): Locale {
  const value = raw?.trim().toLowerCase()
  return value === 'en' || value === 'es' ? value : DEFAULT_LOCALE
}

export function messagesFor(locale: Locale): Messages {
  return CATALOG[locale]
}

/** Answers like `s`, `si`, `sí`, `y`, `yes` count as yes, in either locale. */
export function isAffirmative(answer: string): boolean {
  return ['s', 'si', 'sí', 'y', 'yes'].includes(answer.trim().toLowerCase())
}
