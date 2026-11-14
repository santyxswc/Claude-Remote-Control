/**
 * Every user-facing string (bot replies and CLI output). Spanish is the
 * default; `TELEGRAM_BRIDGE_LOCALE=en` switches to English. Diagnostic logs
 * on stderr are not user-facing and stay in English.
 */
import type { CaptureKind } from '../../domain/capture/CaptureTarget.ts'
import { sanitizeDisplayText, sanitizeUsername } from '../../domain/displayText.ts'
import type { PermissionOutcome } from '../permissions/PermissionOutcome.ts'
import type { CaptureUnavailable } from '../ports/ScreenCapturer.ts'

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
      'No es posible saber desde aquí si la sesión cargó este canal ni si Claude está ocupado.',
    ),
  commandStartDescription: 'comprueba que el puente está conectado',
  commandHelpDescription: 'muestra esta ayuda',
  commandStatusDescription: 'estado del puente',
  commandStopDescription: 'botón de pánico: frena a Claude y deniega los permisos pendientes',
  commandResumeDescription: 'retira el freno de /stop',
  slowDown: 'Vas muy rápido: los mensajes de más se descartaron. Espera unos segundos.',
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
      'From here it cannot be known whether the session loaded this channel or whether Claude is busy.',
    ),
  commandStartDescription: 'check that the bridge is connected',
  commandHelpDescription: 'show this help',
  commandStatusDescription: 'bridge status',
  commandStopDescription: 'panic button: brakes Claude and denies pending permissions',
  commandResumeDescription: 'releases the /stop brake',
  slowDown: 'You are going too fast: the extra messages were dropped. Wait a few seconds.',
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
