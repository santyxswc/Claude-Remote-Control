import { isPermissionRequestId } from '../../domain/permissions/PermissionRequest.ts'

/** What a permission button does. */
export type PermissionAction = 'approve' | 'deny' | 'confirm' | 'cancel'

const CODES: Readonly<Record<PermissionAction, string>> = {
  approve: 'a',
  deny: 'd',
  confirm: 'c',
  cancel: 'x',
}

const ACTIONS: Readonly<Record<string, PermissionAction>> = {
  a: 'approve',
  d: 'deny',
  c: 'confirm',
  x: 'cancel',
}

/** Version 1 of our button data: `p1:<request id>:<action code>`, 10 bytes. */
const CALLBACK_DATA = /^p1:([a-km-z]{5}):([adcx])$/

export interface PermissionCallback {
  readonly requestId: string
  readonly action: PermissionAction
}

export function encodePermissionCallback(requestId: string, action: PermissionAction): string {
  if (!isPermissionRequestId(requestId)) throw new Error('invalid permission request id')
  return `p1:${requestId}:${CODES[action]}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parsePermissionCallback(data: string | undefined): PermissionCallback | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  const requestId = match?.[1]
  const action = ACTIONS[match?.[2] ?? '']
  if (requestId === undefined || action === undefined) return undefined
  return { requestId, action }
}
