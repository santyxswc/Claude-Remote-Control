import { describe, expect, test } from 'bun:test'
import { MAX_CAPTURE_URL_LENGTH, parseCaptureUrl } from '../../../src/domain/capture/captureUrl.ts'
import {
  chooseImageDelivery,
  DOCUMENT_MAX_BYTES,
  PHOTO_MAX_BYTES,
} from '../../../src/domain/capture/imageDelivery.ts'
import { readPngSize } from '../../../src/domain/capture/pngSize.ts'
import { makePng } from '../../png.ts'

describe('parseCaptureUrl', () => {
  test.each([
    ['http://localhost:3000', 'http://localhost:3000/', 'localhost:3000'],
    ['localhost:3000', 'http://localhost:3000/', 'localhost:3000'],
    ['localhost:5173/app?x=1#top', 'http://localhost:5173/app?x=1#top', 'localhost:5173'],
    ['localhost', 'http://localhost/', 'localhost'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/', '127.0.0.1:8080'],
    ['192.168.1.20:3000/admin', 'http://192.168.1.20:3000/admin', '192.168.1.20:3000'],
    ['[::1]:3000', 'http://[::1]:3000/', '[::1]:3000'],
    ['example.com/docs', 'http://example.com/docs', 'example.com'],
    ['  https://Example.COM/a  ', 'https://example.com/a', 'example.com'],
    ['HTTP://example.com', 'http://example.com/', 'example.com'],
  ])('%p is allowed', (raw, url, host) => {
    expect(parseCaptureUrl(raw)).toEqual({ ok: true, target: { kind: 'url', url, host } })
  })

  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['file:///etc/passwd', 'scheme'],
    ['FILE:///C:/Windows/win.ini', 'scheme'],
    ['chrome://settings', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<h1>x</h1>', 'scheme'],
    ['about:blank', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['view-source:http://example.com', 'scheme'],
    ['http://user:pass@localhost:3000', 'credentials'],
    ['http://token@example.com', 'credentials'],
    ['localhost:3000@evil.example', 'scheme'],
    ['http://localhost:3000@evil.example', 'credentials'],
    ['--user-data-dir=/tmp/x', 'unparseable'],
    ['-x', 'unparseable'],
    ['http://exa mple.com', 'unparseable'],
    ['http://example.com/\nfoo', 'unparseable'],
    ['http://', 'unparseable'],
    ['http://[::1', 'unparseable'],
    [`http://example.com/${'a'.repeat(MAX_CAPTURE_URL_LENGTH)}`, 'too_long'],
  ] as const)('%p is refused (%s)', (raw, problem) => {
    expect(parseCaptureUrl(raw)).toEqual({ ok: false, problem })
  })

  test('the normalized URL never starts with a dash', () => {
    for (const raw of ['localhost:1', 'a.b', '-a.b', '--', '-']) {
      const result = parseCaptureUrl(raw)
      if (result.ok) expect(result.target.url.startsWith('http')).toBe(true)
    }
  })
})

describe('readPngSize', () => {
  test('reads width and height from a real PNG', () => {
    expect(readPngSize(makePng(3, 2))).toEqual({ width: 3, height: 2 })
    expect(readPngSize(makePng(1, 1).subarray(0, 24))).toEqual({ width: 1, height: 1 })
  })

  test('large dimensions above 2^31 are read unsigned', () => {
    const head = makePng(1, 1).slice(0, 24)
    head.set([0xff, 0xff, 0xff, 0xff], 16)
    expect(readPngSize(head)?.width).toBe(0xffffffff)
  })

  test.each([
    ['too short', makePng(2, 2).subarray(0, 23)],
    ['not a PNG', new TextEncoder().encode('GIF89a......................')],
    [
      'IHDR missing',
      (() => {
        const bytes = makePng(2, 2).slice(0, 24)
        bytes.set([0x49, 0x44, 0x41, 0x54], 12)
        return bytes
      })(),
    ],
    [
      'zero width',
      (() => {
        const bytes = makePng(2, 2).slice(0, 24)
        bytes.set([0, 0, 0, 0], 16)
        return bytes
      })(),
    ],
  ])('%s: undefined', (_label, head) => {
    expect(readPngSize(head)).toBeUndefined()
  })
})

describe('chooseImageDelivery', () => {
  test('a normal screenshot is a photo', () => {
    expect(chooseImageDelivery(800_000, { width: 1920, height: 1080 })).toBe('photo')
    expect(chooseImageDelivery(PHOTO_MAX_BYTES, { width: 5000, height: 5000 })).toBe('photo')
    expect(chooseImageDelivery(1, { width: 20, height: 1 })).toBe('photo')
  })

  test.each([
    ['over 10 MB', PHOTO_MAX_BYTES + 1, { width: 1920, height: 1080 }],
    ['width + height over 10000', 1_000, { width: 7680, height: 2400 }],
    ['ratio over 20', 1_000, { width: 2100, height: 100 }],
    ['ratio over 20, tall', 1_000, { width: 100, height: 2100 }],
    ['unknown dimensions', 1_000, undefined],
  ])('%s: a document', (_label, bytes, size) => {
    expect(chooseImageDelivery(bytes, size)).toBe('document')
  })

  test('over 50 MB is too large; nothing is empty', () => {
    expect(chooseImageDelivery(DOCUMENT_MAX_BYTES, undefined)).toBe('document')
    expect(chooseImageDelivery(DOCUMENT_MAX_BYTES + 1, { width: 10, height: 10 })).toBe('too_large')
    expect(chooseImageDelivery(0, { width: 10, height: 10 })).toBe('empty')
  })
})
