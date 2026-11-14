import { z } from 'zod'

/**
 * The hub <-> spoke messages (F14, ADR 0017), validated strictly on both
 * ends: unknown keys are refused, every string is bounded, every id has its
 * shape. A frame that does not parse is dropped and logged by type only.
 * `v` is checked at registration; a mismatch is refused with a clear reason.
 */
export const HUB_PROTOCOL_VERSION = 1

const id = z.string().regex(/^[1-9][0-9]{0,19}$/)
const chatRef = z.string().regex(/^-?[1-9][0-9]{0,19}$/)
const session = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = (max: number) => z.string().max(max)

const sender = z.strictObject({
  id,
  username: z.string().max(64).optional(),
  displayName: z.string().max(256),
})

const promptRef = z.strictObject({ chatId: chatRef, messageId: id })

const keyboard = z
  .array(z.array(z.strictObject({ label: text(1024), data: text(64) })).max(12))
  .max(100)

const photoSize = z.strictObject({
  fileId: text(256),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  size: z.number().int().nonnegative().optional(),
})

/** What a spoke receives: the hub's translation, a private-chat view of its topic. */
export const SpokeMessage = z.strictObject({
  chatId: id,
  messageId: id,
  chatKind: z.literal('private'),
  sender: sender.optional(),
  text: text(65_536).optional(),
  sentAt: z.number().int(),
  attachment: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('photo'), sizes: z.array(photoSize).max(20) }),
      z.strictObject({
        kind: z.literal('document'),
        fileId: text(256),
        fileName: text(1024).optional(),
        size: z.number().int().nonnegative().optional(),
      }),
    ])
    .optional(),
  caption: text(4096).optional(),
  mediaGroupId: text(256).optional(),
  voice: z
    .strictObject({
      fileId: text(256),
      duration: z.number().int().nonnegative().optional(),
      size: z.number().int().nonnegative().optional(),
    })
    .optional(),
})

export const SpokeCallback = z.strictObject({
  id: text(256),
  chatId: id,
  chatKind: z.literal('private'),
  messageId: id.optional(),
  sender,
  data: text(256).optional(),
})

const request = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('sendText'),
    chatId: id,
    text: text(16_384),
    replyTo: id.optional(),
  }),
  z.strictObject({ op: z.literal('typing'), chatId: id }),
  z.strictObject({ op: z.literal('sendPrompt'), chatId: id, text: text(16_384), keyboard }),
  z.strictObject({ op: z.literal('editPrompt'), ref: promptRef, text: text(16_384), keyboard }),
  z.strictObject({
    op: z.literal('answerCallback'),
    callbackId: text(256),
    text: text(1024).optional(),
  }),
  z.strictObject({
    op: z.literal('sendImage'),
    chatId: id,
    image: z.strictObject({
      path: text(4096),
      filename: text(256),
      as: z.enum(['photo', 'document']),
    }),
    caption: text(4096),
  }),
  z.strictObject({
    op: z.literal('sendDocument'),
    chatId: id,
    document: z.strictObject({
      filename: text(256),
      text: text(300_000),
      maxBytes: z.number().int().positive().max(400_000),
      cutNote: text(1024),
    }),
    caption: text(4096),
  }),
  z.strictObject({ op: z.literal('sendStatus'), chatId: id, text: text(16_384) }),
  z.strictObject({ op: z.literal('editStatus'), ref: promptRef, text: text(16_384) }),
  z.strictObject({ op: z.literal('pinStatus'), ref: promptRef }),
  z.strictObject({ op: z.literal('unpinStatus'), ref: promptRef }),
  z.strictObject({
    op: z.literal('download'),
    fileId: text(256),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
  }),
])

export type HubRequest = z.infer<typeof request>

export const SpokeFrame = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('register'),
    v: z.number().int(),
    session,
    projectDir: text(4096),
    projectName: text(256).optional(),
  }),
  z.strictObject({ t: z.literal('req'), id: requestId, request }),
])

export type SpokeFrame = z.infer<typeof SpokeFrame>

/** Why a request failed, so the spoke can rethrow the error the application expects. */
export const HubErrorKind = z.enum([
  'refused',
  'failed',
  'status_gone',
  'status_flood',
  'unavailable',
])

export type HubErrorKind = z.infer<typeof HubErrorKind>

export const HubFrame = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('registered'),
    v: z.number().int(),
    topicId: id,
    topicName: text(256),
    /** Ended sessions that used this topic: their leftovers may be cleaned up. */
    endedSessions: z.array(session).max(50),
  }),
  z.strictObject({
    t: z.literal('refused'),
    reason: z.enum(['version', 'not_configured', 'invalid', 'duplicate_session', 'failed']),
  }),
  z.strictObject({ t: z.literal('res'), id: requestId, value: z.unknown() }),
  z.strictObject({
    t: z.literal('err'),
    id: requestId,
    kind: HubErrorKind,
    message: text(1024),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ t: z.literal('message'), message: SpokeMessage }),
  z.strictObject({ t: z.literal('tap'), callback: SpokeCallback }),
  z.strictObject({ t: z.literal('hook'), payload: z.unknown() }),
  z.strictObject({ t: z.literal('brake'), sender }),
])

export type HubFrame = z.infer<typeof HubFrame>

/** Values of successful responses, checked by the spoke per operation. */
export const PromptRefValue = promptRef
export const SendReceiptValue = z.strictObject({
  parts: z.number().int().nonnegative(),
  redactions: z.number().int().nonnegative(),
})
export const DocumentReceiptValue = z.strictObject({
  redactions: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  cut: z.boolean(),
})
export const DownloadValue = z.strictObject({
  path: text(4096),
  size: z.number().int().nonnegative(),
})
