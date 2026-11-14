# ADR 0016: Voice notes are transcribed locally and confirmed before they are sent

- Status: Accepted
- Date: 2026-11-14

## Context

F13 lets the owner dictate from the phone. A voice note is untrusted media from Telegram; its
transcript becomes an instruction to Claude. Four questions: where the speech is recognized,
how untrusted audio is handled on the PC, how the owner knows what Claude will receive, and how
a transcript that reads like a bridge command ("/stop", "yes abcde") is kept from acting as one.

## Decision

1. **Local only, opt-in.** whisper.cpp's `whisper-cli` on the PC, no cloud service and no new
   npm dependency. Off until `TELEGRAM_BRIDGE_WHISPER_MODEL` names an existing ggml model by
   absolute path. `TELEGRAM_BRIDGE_WHISPER`, `TELEGRAM_BRIDGE_FFMPEG` (absolute overrides, else
   `whisper-cli` and `ffmpeg` on `PATH`, looked up once) and `TELEGRAM_BRIDGE_WHISPER_LANGUAGE`
   (`auto` default) complete it, in the style of the screenshot settings. The bridge never
   downloads a model or installs anything.
2. **ffmpeg is required.** The bridge does not rely on whisper.cpp decoding Opus. Its CLI
   README lists "flac, mp3, ogg, wav", but the decoder in `examples/common-whisper.cpp`
   (miniaudio with stb_vorbis) handles Ogg Vorbis, and Telegram voice notes are Ogg Opus. The
   main README says the CLI "currently runs only with 16-bit WAV files" and gives the ffmpeg
   conversion `-ar 16000 -ac 1 -c:a pcm_s16le`. A missing ffmpeg gets its own help reply.
3. **Only `voice`.** `audio` (music files with metadata) and `video_note` stay unsupported:
   they are not dictation, and they would widen what ffmpeg is asked to parse.
4. **Checks before any byte.** Same chain as text up to the brake gate. Then availability,
   declared duration (missing or over 180 s refused), declared size (over 2 MB, or the F10 cap
   if smaller, refused) and the queue (one running plus one waiting) are checked before
   `getFile`. The download reuses F10's source, counts the streamed bytes against the cap and
   sniffs `OggS`.
5. **The audio is a short-lived local file.** `<stateDir>/voice/<random>/voice.ogg`, directory
   0700, file 0600, created `wx`. The workspace is removed in a `finally` after transcription,
   whatever the outcome; stale workspaces (over 30 minutes, our own name pattern only) are
   swept when the poller lock is taken. The audio is never forwarded to Claude, never logged,
   never audited.
6. **Hardened child processes** (`spawnCapturing`): fixed argv with an allowlist test (only the
   model path and a validated language vary), no shell, cwd is the workspace and every file
   name is relative to it, stdin ignored, stderr discarded, stdout capped, an environment with
   only `PATH`, `LD_LIBRARY_PATH`, `SYSTEMROOT`, `WINDIR` and temp variables pointing at the
   workspace (the bot token never reaches a child). ffmpeg gets `-protocol_whitelist file`, a
   forced `ogg` demuxer, `-t 181` on the input, the first audio stream only, no metadata, a
   `-fs` cap on the WAV and `-n`. Deadlines kill: 30 s for the conversion, 60 s + 3 s per second
   of audio (at most 600 s) for whisper. Exit 0 without a transcript file is a failure. The
   transcript file is read up to 64 KiB, cleaned (timestamps, `[BLANK_AUDIO]`, controls, bidi,
   zero-width) and refused, never cut, above 3,500 code points.
7. **What is sent is exactly what was shown.** The transcript is stored as a `VoiceTranscript`
   (pending, sent, discarded, expired, cancelled; compare-and-set revisions; SQLite
   `voice_transcripts`, schema version 6; the text erased once closed) and shown with Send and
   Discard (`v1:<id>:<s|d>`). The prompt uses `redaction: 'refuse'` and `overflow: 'refuse'`:
   a transcript redaction would change, or one that does not fit a single message, is not
   offered. Send passes the stored text, not anything from the tap. Confirmations expire after
   10 minutes and belong to the polling session (ADR 0007).
8. **A transcript is text, never a bridge command or a verdict.** A confirmed transcript runs a
   dedicated chain: the shared per-sender rate limiter, the brake gate, typed "Other..." choice
   answers, delivery. It has no `CommandRouterStep` and no `PermissionVerdictStep`, so the
   structure, not a string check, keeps "/stop", "/pair" or "yes abcde" from acting. It may
   answer a waiting "Other..." choice (the meta then carries `source="voice"`), because that is
   free text the owner meant to type. The channel meta otherwise says `kind="voice"` and
   `transcript_id`, and the channel instructions tell Claude it may contain recognition
   mistakes.
9. **Brake.** A voice note while braked gets the brake notice before download. A Send while
   braked gets the brake toast and leaves the transcript pending. Transcription runs off the
   chain, so `/stop` is never delayed by it; channel shutdown aborts it and kills the child.
10. **Audit without words.** `voice.refused` (reason), `voice.transcribed` (id, declared
    seconds and bytes, bytes received, milliseconds, characters), `voice.sent` (id,
    characters), `voice.discarded`, `voice.expired` (ttl or orphaned).

## Consequences

- Setup is the owner's: install whisper.cpp and ffmpeg, download a model. The help replies
  name the exact setting that is missing and point to `docs/flows/F13.md`.
- A note dictated with a password in it cannot be sent at all. Deliberate: Send would deliver a
  text the owner did not see.
- whisper.cpp and ffmpeg parse untrusted audio without a sandbox. The exposure is limited to an
  allowlisted owner's notes, capped in size and time, with a scrubbed environment.
- Limits are tighter than the plan's example (3 minutes instead of 5) so that a full-length
  transcript fits one Telegram message and can be confirmed whole.
- Duration and size come from the sender's client and can lie; the received bytes, ffmpeg's
  `-t` and `-fs`, and the deadlines bound the cost.

## Needs live verification

- Real `whisper-cli` and `ffmpeg` with real voice notes on Arch, Windows and macOS; the time to
  transcribe with `base` and `small` on a CPU; `auto` language detection on Spanish.
- Windows release asset names and whether they need extra DLLs on `PATH`.
- Whether Claude Code treats a `/name` in channel content as a slash command (open since F7).
