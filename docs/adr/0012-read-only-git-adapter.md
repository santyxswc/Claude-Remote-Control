# ADR 0012: A read-only git adapter, and buttons that are instructions

- Status: Accepted
- Date: 2026-11-14

## Context

F8 shows the project's uncommitted changes in the chat and offers Commit, Revert and Open PR. Two
risks come with it.

- **Running git on a repository runs the repository's configuration.** Several settings name
  programs that `git status` or `git diff` start: external diff drivers, textconv, clean and
  process filters, `core.fsmonitor`, hooks (after an index write) and the pager. A cloned or
  tampered repository could turn `/diff` into code execution.
- **Buttons that change the repository would be a second approval path** next to the permission
  relay (F3). That path would have its own bugs and would bypass the brake and the risk rules.

## Decision

1. **The bridge only reads.** `GitCli` can run seven fixed invocations (`rev-parse`,
   `config --get-regexp ^filter\.`, `status`, four `diff`s) and nothing else. They are typed in
   `gitInvocations.ts`, and an argv allowlist test enumerates every argv the adapter can produce.
   There is no fetch, push, commit or checkout, and no network.
2. **Every invocation is hardened** against configuration that runs programs:
   - `--no-pager`, `--no-optional-locks`, `--literal-pathspecs`;
   - `-c core.fsmonitor=false`, `-c core.hooksPath=<null device>`;
   - `-c protocol.allow=never` and `GIT_NO_LAZY_FETCH=1`, so a partial clone cannot make `diff`
     fetch a missing object (and run `core.sshCommand` or a remote helper);
   - `diff --no-ext-diff --no-textconv --no-color`, `--ignore-submodules=dirty`;
   - every configured filter driver disabled with `-c filter.<name>.{clean,smudge,process}=` and
     `required=false`, after listing them with `git config`;
   - a scrubbed environment plus `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and
     `GIT_LITERAL_PATHSPECS=1`;
   - an argument array, no shell, an explicit cwd, a 15 s timeout and a read cap.

   A filter name that `-c` cannot express, or a listing too long to read whole, refuses the read
   (`unsafe_config`) instead of guessing.
3. **The path filter is policy, not quoting.** `parseDiffPathFilter` refuses absolute paths,
   `..`, a leading `-` or `:`, and controls before any process runs. The path then goes after
   `--` with literal pathspecs forced.
4. **Redact the whole text, then cap.** A diff is the most likely place for a secret to leave the
   PC.
   - The document is redacted whole inside `buildOutbound()` (`RedactingDocumentGateway`).
   - Only then is it cut to 5 MB between lines.
   - A read cut by the adapter's cap drops its partial last line first.
5. **A button is an instruction, not an approval.** The prefix is `g1:`, with an anchored
   parser, and it never reaches `ResolvePermission`. A tap feeds one fixed catalog text into the
   full inbound chain as owner text, like a skill tap (ADR 0011): rate limit, brake gate, audit.
   Claude then asks permission for every git command it runs. Revert needs Confirm. The text
   holds nothing from the repository.

## Alternatives considered

- **Run git through a library (isomorphic-git, libgit2).** It would avoid the configuration
  vectors, but adds a large dependency and can disagree with the git the owner uses. Rejected.
- **Let the buttons run `git commit` / `git checkout -- .` directly.** That is faster, but it
  creates a write path that skips the permission prompt, the risk rules and the brake. Rejected.
- **Refuse `/diff` whenever any filter is configured.** It is safe, but breaks Git LFS
  repositories. Disabling the drivers shows LFS pointer files instead, which is the honest
  content.

## Consequences

- `/diff` works while braked, because reading is harmless; the buttons do not.
- In LFS repositories the diff shows pointer text, not file content. Binary files show as binary.
- The vectors were verified live on Windows with git 2.55.0. A control test shows each one firing
  under a plain git, and the adapter test shows none firing (F8). A future git setting that
  starts a program and is not covered by these flags would not be blocked; the allowlist test
  and the threat model are where to add it.
- Redaction is best effort. A secret without a known shape (a password in a config file that is
  not `.env`) reaches the chat in the diff. The caption says so.
- Needs live verification: how Claude carries out each instruction, and how the document
  renders on the phone.
