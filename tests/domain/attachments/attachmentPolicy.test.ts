import { describe, expect, test } from 'bun:test'
import {
  ALLOWED_TYPES,
  checkDeclaredSize,
  checkHead,
  choosePhotoSize,
  extensionOf,
  maxUploadBytes,
  PHOTO_TYPE,
  sanitizeAttachmentName,
  sniff,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
  TextContentCheck,
  typeForName,
} from '../../../src/domain/attachments/attachmentPolicy.ts'

const bytes = (...values: number[]) => new Uint8Array(values)
const ascii = (text: string) => new TextEncoder().encode(text)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1)
const WEBP = ascii('RIFF\x10\x00\x00\x00WEBP')

describe('maxUploadBytes', () => {
  test('unset is the Bot API limit', () => {
    expect(maxUploadBytes(undefined)).toEqual({
      bytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES,
      invalid: false,
    })
    expect(maxUploadBytes('  ')).toEqual({ bytes: 20_000_000, invalid: false })
  })

  test('whole MB from 1 to 20 lower it', () => {
    expect(maxUploadBytes('1')).toEqual({ bytes: 1_000_000, invalid: false })
    expect(maxUploadBytes(' 20 ')).toEqual({ bytes: 20_000_000, invalid: false })
  })

  test.each(['0', '21', '100', '-1', '1.5', 'ten', '1e1', '0x10'])(
    '%p cannot raise or break it',
    (raw) => expect(maxUploadBytes(raw)).toEqual({ bytes: 20_000_000, invalid: true }),
  )
})

describe('names and types', () => {
  test('the extension is the last plain one, lowercased', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf')
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('trailing.txt. . ')).toBe('txt')
    expect(extensionOf('README')).toBeUndefined()
    expect(extensionOf('.env')).toBe('env')
    expect(extensionOf(undefined)).toBeUndefined()
    expect(extensionOf('x.p\u202edf')).toBeUndefined()
  })

  test('only allowlisted extensions get a type', () => {
    expect(typeForName('a.png')).toMatchObject({ kind: 'binary', magic: 'png' })
    expect(typeForName('a.md')).toMatchObject({ kind: 'text', mime: 'text/markdown' })
    for (const name of [
      'a.svg',
      'a.exe',
      'a.bat',
      'a.ps1',
      'a.cmd',
      'a.zip',
      'a.docx',
      'a',
      '.env',
    ]) {
      expect(typeForName(name)).toBeUndefined()
    }
    expect(PHOTO_TYPE).toMatchObject({ extension: 'jpg', mime: 'image/jpeg' })
  })

  test('every allowed extension is a plain lowercase word', () => {
    for (const extension of ALLOWED_TYPES.keys()) expect(extension).toMatch(/^[a-z0-9]{1,10}$/)
  })

  test.each([
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['..\\..\\windows\\system32\\x.dll', '.._.._windows_system32_x.dll'],
    ['/abs/path.png', '_abs_path.png'],
    ['C:\\Users\\x.txt', 'C__Users_x.txt'],
    ['CON', 'CON'],
    ['name. . .', 'name'],
    ['...', 'file'],
    ['', 'file'],
    ['evil\u202egnp.exe', 'evilgnp.exe'],
    ['a\u0000b.txt', 'a b.txt'],
    ['a*b?c"d<e>f|g:h.txt', 'a_b_c_d_e_f_g_h.txt'],
  ])('sanitizes %p', (raw, expected) => {
    expect(sanitizeAttachmentName(raw)).toBe(expected)
  })

  test('long names are capped', () => {
    expect([...sanitizeAttachmentName(`${'x'.repeat(500)}.txt`)].length).toBeLessThanOrEqual(128)
  })
})

describe('sizes', () => {
  test('the declared size', () => {
    expect(checkDeclaredSize(undefined, 10)).toBeUndefined()
    expect(checkDeclaredSize(10, 10)).toBeUndefined()
    expect(checkDeclaredSize(11, 10)).toBe('too_large')
    expect(checkDeclaredSize(0, 10)).toBe('empty')
  })

  test('the largest photo size that fits', () => {
    const sizes = [
      { fileId: 's', width: 90, height: 90, size: 1_000 },
      { fileId: 'm', width: 320, height: 320, size: 10_000 },
      { fileId: 'l', width: 1280, height: 1280, size: 100_000 },
    ]
    expect(choosePhotoSize(sizes, 1_000_000)?.fileId).toBe('l')
    expect(choosePhotoSize(sizes, 50_000)?.fileId).toBe('m')
    expect(choosePhotoSize(sizes, 10)).toBeUndefined()
    expect(
      choosePhotoSize([{ fileId: 'u', width: 1, height: 1, size: undefined }], 1)?.fileId,
    ).toBe('u')
  })
})

describe('content', () => {
  test('sniffs the binary types', () => {
    expect(sniff(PNG)).toBe('png')
    expect(sniff(JPEG)).toBe('jpeg')
    expect(sniff(ascii('GIF89a......'))).toBe('gif')
    expect(sniff(ascii('GIF87a......'))).toBe('gif')
    expect(sniff(WEBP)).toBe('webp')
    expect(sniff(ascii('%PDF-1.7\n'))).toBe('pdf')
    expect(sniff(ascii('RIFF\x10\x00\x00\x00WAVE'))).toBeUndefined()
    expect(sniff(ascii('hello'))).toBeUndefined()
    expect(sniff(new Uint8Array(0))).toBeUndefined()
  })

  test('a binary type must match its magic', () => {
    const png = ALLOWED_TYPES.get('png')
    const jpg = ALLOWED_TYPES.get('jpg')
    if (png === undefined || jpg === undefined) throw new Error('missing types')
    expect(checkHead(png, PNG)).toBeUndefined()
    expect(checkHead(png, JPEG)).toBe('type_mismatch')
    expect(checkHead(jpg, ascii('<html>'))).toBe('type_mismatch')
  })

  test('a text type must not be one of the binary types', () => {
    const txt = ALLOWED_TYPES.get('txt')
    if (txt === undefined) throw new Error('missing type')
    expect(checkHead(txt, ascii('hello world!'))).toBeUndefined()
    expect(checkHead(txt, ascii('%PDF-1.4 ...'))).toBe('type_mismatch')
  })

  test('text must be UTF-8 without NUL, even across chunks', () => {
    const ok = new TextContentCheck()
    const snow = ascii('☃')
    expect(ok.push(snow.subarray(0, 1))).toBe(true)
    expect(ok.push(snow.subarray(1))).toBe(true)
    expect(ok.finish()).toBe(true)

    const nul = new TextContentCheck()
    expect(nul.push(bytes(104, 0, 105))).toBe(false)
    expect(nul.push(ascii('more'))).toBe(false)
    expect(nul.finish()).toBe(false)

    const latin1 = new TextContentCheck()
    expect(latin1.push(bytes(0x63, 0x61, 0x66, 0xe9, 0x20))).toBe(false)

    const cut = new TextContentCheck()
    expect(cut.push(snow.subarray(0, 2))).toBe(true)
    expect(cut.finish()).toBe(false)

    const bom = new TextContentCheck()
    expect(bom.push(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe(true)
    expect(bom.finish()).toBe(true)
  })
})
