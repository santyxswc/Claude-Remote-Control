/**
 * Every user-facing string (bot replies and CLI output). Spanish is the
 * default; `TELEGRAM_BRIDGE_LOCALE=en` switches to English. Diagnostic logs
 * on stderr are not user-facing and stay in English.
 */
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
  readonly slowDown: string
  readonly onlyTextSupported: string
  readonly queued: string
  readonly deliveryFailed: string

  // CLI: general
  readonly usage: string
  readonly unknownCommand: string
  readonly unexpectedError: (detail: string) => string
  readonly notConfigured: string

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

const USAGE_ES = `Uso: telegram-bridge <comando>

Comandos:
  init [--token-stdin]   Configura el bot con el token de BotFather
  pair                   Empareja tu cuenta de Telegram con este PC
  access list            Lista las cuentas permitidas
  access revoke <id>     Retira el acceso a una cuenta
  --help                 Muestra esta ayuda

El token nunca se pasa como argumento: init lo pide sin mostrarlo o lo lee de stdin.`

const USAGE_EN = `Usage: telegram-bridge <command>

Commands:
  init [--token-stdin]   Configure the bot with the BotFather token
  pair                   Pair your Telegram account with this PC
  access list            List the allowed accounts
  access revoke <id>     Remove an account's access
  --help                 Show this help

The token is never passed as an argument: init asks for it without echo or reads it from stdin.`

function who(c: ClaimantView): string {
  const handle = c.username === undefined ? '' : ` (@${c.username})`
  return `${c.displayName}${handle}, id ${c.id}`
}

function commandList(commands: readonly CommandHelp[]): string {
  return commands.map((c) => `/${c.name} - ${c.description}`).join('\n')
}

const es: Messages = {
  pairingClaimedReply:
    'Código recibido. Confirma el emparejamiento en la terminal de tu PC para continuar.',
  startGreeting:
    'Puente conectado. Lo que escribas aquí llega a tu sesión de Claude Code. /help muestra los comandos.',
  help: (commands) =>
    `Comandos:\n${commandList(commands)}\n\nCualquier otro texto, incluidos otros /comandos, se envía a Claude.`,
  status: (v) =>
    [
      `Bot: ${v.botUsername === undefined ? 'desconocido' : `@${v.botUsername}`}`,
      `Emparejado desde: ${v.pairedSince ?? 'desconocido'}`,
      `Conexión MCP con Claude Code: ${v.sessionConnected ? 'abierta' : 'cerrada'}`,
      'No es posible saber desde aquí si la sesión cargó este canal ni si Claude está ocupado.',
    ].join('\n'),
  commandStartDescription: 'comprueba que el puente está conectado',
  commandHelpDescription: 'muestra esta ayuda',
  commandStatusDescription: 'estado del puente',
  slowDown: 'Vas muy rápido: los mensajes de más se descartaron. Espera unos segundos.',
  onlyTextSupported: 'Por ahora solo se admite texto. Ese mensaje no se envió a Claude.',
  queued: 'Claude está ocupado: tu mensaje quedó en cola y lo verá al terminar.',
  deliveryFailed: 'No se pudo entregar el mensaje a la sesión de Claude Code.',

  usage: USAGE_ES,
  unknownCommand: 'Comando o argumentos no válidos.',
  unexpectedError: (detail) => `Error inesperado: ${detail}`,
  notConfigured: 'El bot no está configurado. Ejecuta primero: telegram-bridge init',

  initTokenPrompt: 'Pega el token que te dio @BotFather (no se mostrará): ',
  initTokenEmpty: 'No se recibió ningún token.',
  initNeedsTerminal:
    'No hay una terminal interactiva. Usa: telegram-bridge init --token-stdin < archivo',
  initStdinIsTerminal:
    '--token-stdin espera el token por una tubería, por ejemplo: telegram-bridge init --token-stdin < archivo',
  initValidating: 'Validando el token con Telegram...',
  initInvalidToken: 'Telegram rechazó el token. Revísalo en @BotFather e inténtalo de nuevo.',
  initUnreachable: (detail) => `No se pudo contactar a Telegram (${detail}). Revisa tu conexión.`,
  initDone: (username) => `Listo: el bot @${username} quedó configurado.`,
  initEnvOverride:
    'Aviso: la variable TELEGRAM_BOT_TOKEN está definida y tiene prioridad sobre el token guardado.',
  initNextStep: 'Siguiente paso: telegram-bridge pair',

  pairScan: 'Escanea este código QR con tu teléfono, o abre el enlace:',
  pairLink: (link) => link,
  pairExpiresIn: (seconds) => `El código vence en ${seconds} segundos y sirve una sola vez.`,
  pairUsingChannel:
    'La sesión de Claude Code está recibiendo los mensajes del bot; esperando el código...',
  pairPollingHere: 'Esperando el código en Telegram...',
  pairAnotherInProgress: (pid) =>
    `Ya hay otro emparejamiento en curso (proceso ${pid}). Termínalo o espera a que venza.`,
  pairClaimedBy: (c) => `Código recibido de: ${who(c)}`,
  pairConfirmPrompt: '¿Es tu cuenta? Solo esa cuenta podrá controlar este PC. [s/N] ',
  pairConfirmed: (c) => `Emparejado. ${who(c)} ya puede usar el bot.`,
  pairDeclined: 'Emparejamiento rechazado. Nadie obtuvo acceso.',
  pairExpired: 'El código venció sin confirmarse. Ejecuta pair de nuevo.',
  pairCancelled: 'El emparejamiento se canceló (demasiados intentos o fue reemplazado).',
  pairTokenRejected: 'Telegram rechazó el token. Ejecuta telegram-bridge init de nuevo.',
  pairPollingConflict:
    'Otro programa está leyendo los mensajes de este bot. Ciérralo e inténtalo de nuevo.',

  accessListEmpty: 'No hay cuentas permitidas. Usa telegram-bridge pair para agregar una.',
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
    [
      `Bot: ${v.botUsername === undefined ? 'unknown' : `@${v.botUsername}`}`,
      `Paired since: ${v.pairedSince ?? 'unknown'}`,
      `MCP connection to Claude Code: ${v.sessionConnected ? 'open' : 'closed'}`,
      'From here it cannot be known whether the session loaded this channel or whether Claude is busy.',
    ].join('\n'),
  commandStartDescription: 'check that the bridge is connected',
  commandHelpDescription: 'show this help',
  commandStatusDescription: 'bridge status',
  slowDown: 'You are going too fast: the extra messages were dropped. Wait a few seconds.',
  onlyTextSupported: 'Only text is supported for now. That message was not sent to Claude.',
  queued: 'Claude is busy: your message is queued and Claude will see it when done.',
  deliveryFailed: 'The message could not be delivered to the Claude Code session.',

  usage: USAGE_EN,
  unknownCommand: 'Invalid command or arguments.',
  unexpectedError: (detail) => `Unexpected error: ${detail}`,
  notConfigured: 'The bot is not configured. Run first: telegram-bridge init',

  initTokenPrompt: 'Paste the token from @BotFather (it will not be shown): ',
  initTokenEmpty: 'No token was received.',
  initNeedsTerminal: 'No interactive terminal. Use: telegram-bridge init --token-stdin < file',
  initStdinIsTerminal:
    '--token-stdin expects the token on a pipe, for example: telegram-bridge init --token-stdin < file',
  initValidating: 'Validating the token with Telegram...',
  initInvalidToken: 'Telegram rejected the token. Check it in @BotFather and try again.',
  initUnreachable: (detail) => `Could not reach Telegram (${detail}). Check your connection.`,
  initDone: (username) => `Done: the bot @${username} is configured.`,
  initEnvOverride:
    'Note: the TELEGRAM_BOT_TOKEN variable is set and takes precedence over the saved token.',
  initNextStep: 'Next step: telegram-bridge pair',

  pairScan: 'Scan this QR code with your phone, or open the link:',
  pairLink: (link) => link,
  pairExpiresIn: (seconds) => `The code expires in ${seconds} seconds and works once.`,
  pairUsingChannel:
    'The Claude Code session is receiving the bot messages; waiting for the code...',
  pairPollingHere: 'Waiting for the code on Telegram...',
  pairAnotherInProgress: (pid) =>
    `Another pairing is already running (process ${pid}). Finish it or wait for it to expire.`,
  pairClaimedBy: (c) => `Code received from: ${who(c)}`,
  pairConfirmPrompt: 'Is this your account? Only it will be able to control this PC. [y/N] ',
  pairConfirmed: (c) => `Paired. ${who(c)} can now use the bot.`,
  pairDeclined: 'Pairing declined. Nobody was given access.',
  pairExpired: 'The code expired without confirmation. Run pair again.',
  pairCancelled: 'The pairing was cancelled (too many attempts, or it was replaced).',
  pairTokenRejected: 'Telegram rejected the token. Run telegram-bridge init again.',
  pairPollingConflict: "Another program is reading this bot's messages. Close it and try again.",

  accessListEmpty: 'No accounts are allowed. Use telegram-bridge pair to add one.',
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
