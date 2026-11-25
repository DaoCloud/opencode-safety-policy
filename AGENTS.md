# Agent instructions for opencode-safety-policy

An OpenCode 2.x plugin, written in TypeScript for Bun, that statically analyzes every tool call an agent makes and decides `allow`, `ask` or `deny`. The package ships its sources and there is no build step. The design is `docs/opencode-safety-policy-design.md`. Code comments cite its sections, as in `(design 3.1 Stage 3)`, so read the cited section before changing a module.

## Commands

```bash
bun install
bun run typecheck                                    # tsc --noEmit. There is no linter or formatter config
bun test                                             # unit tests. The E2E and system suites skip themselves
bun test test/analyzer.test.ts                       # one file
bun test test/rules-examples.test.ts -t k8s-delete   # by name. Every built-in rule example is its own test
bun run test:e2e                                     # OCSP_E2E=1. Needs `opencode` on PATH (CI pins 2.4.1)
OCSP_E2E=1 bun test test/e2e/tui.test.ts             # one E2E file
bun run test:system                                  # needs docker. Runs test/system in a throwaway container
cd /tmp && bun <repo>/cli.ts test --mode strict "ssh n1 'kubectl delete pod x'"   # judge one command offline
```

- On macOS, E2E first needs `sudo ifconfig lo0 alias 127.0.0.2 up`.
- `cli.ts` uses the current directory as the Location, so run it from a scratch directory.
- Run `test/system` only through `test/system/run.sh`. It rewrites `/etc/opencode` and `/etc/profile.d`.

## Architecture

Entry points, from `exports` in `package.json`:
- `index.ts`: the server plugin.
- `tui.ts`: the TUI plugin with the user-only `/safety` command.
- `rpc.ts`: the RPC contract shared by both.
- `cli.ts`: an offline dry run.

The server hooks are split by what OpenCode lets each hook do (design §2, "为什么这样分工"):
- `src/hooks/tool.ts`: `execute.before` is the only hook that can fail a tool call, so every `deny` is thrown here. A shell call that needs approval is only marked.
- `src/hooks/permission.ts`: `permission.hook("evaluate")` runs after saved `Always` rules. It forces the prompt for marked shell calls. It also guards `edit`, `read`, `grep`, `webfetch` and Code Mode nested calls, which never reach `execute.before`.
- `shell.hook("create.before")` is deliberately not used. It cannot fail a call, and it also fires for the user's own `!cmd`.
- `src/rpc-handlers.ts` serves `status`, `setMode` and `test` to the TUI. `src/command.ts` and `src/hooks/session-filter.ts` add an optional server-side `/safety` (`enableServerSlashCommand`) and hide its messages from the model.

The analyzer pipeline is `src/analyzer.ts` (design §3.1):
1. `tokenizer.ts` parses bash. It returns `opaque` when the input cannot be analyzed statically.
2. Obfuscation and opaque detection, such as dynamic command names or scripts written and then run.
3. `unwrapper.ts` peels `ssh`, `sudo`, `bash -c`, `kubectl exec`, `xargs`, `find -exec` and similar wrappers into "atoms", each local or remote. Option tables for CLIs whose options take values live in `cli-options.ts`.
4. `script-scanner.ts` prescans interpreter code. `http-extractor.ts` extracts curl, wget and HTTPie requests.
5. `src/rules/` matches the atoms and applies the mode matrix. Verdicts combine as deny > ask > allow.

Rules:
- Declarative rules live in `rules/*.json`. `src/rules/loader.ts` loads every file automatically, with no registration. `rules/ssh-readonly.json` is the remote read-only allowlist, loaded by `src/rules/ssh-policy.ts`.
- Some protections are in code instead of JSON:
  - `self-protect`: `src/rules/self-protect.ts` and `server-api.ts`.
  - `protected-endpoint-write`: `src/rules/index.ts`.
  - `unknown-remote-command`: `analyzer.ts`.
- The order of decisions per atom is in `src/rules/index.ts`.

Mode and state:
- `src/state.ts` resolves the mode, highest first:
  1. `OPENCODE_SAFETY_LOCK_MODE`
  2. the runtime state in `ctx.storage`, set by `/safety`, with an optional TTL
  3. `OPENCODE_SAFETY_MODE`
  4. `options.mode`
  5. the default, `relaxed`
- OpenCode creates one plugin instance per Location (directory), and instances share no memory. Mode and stats (`src/stats.ts`) therefore go through `ctx.storage` on every decision. Never keep shared state only in memory.

## Conventions

- **Fail closed.** `createPolicy` never throws, because a failing `setup()` leaves every tool unguarded. Invalid options or rule files make `policy.load()` throw, and the hooks then deny every call except in `off` mode. Storage read errors and invalid env values resolve to `strict`. Stats and the audit log are best-effort: they never reject and never change a decision.
- **Message format.** Deny and ask messages are `[safety-policy:<ruleId>] <reason>`. `tui.ts` relies on this prefix to toast approval reasons.
- **Language.** Rule `reason` fields and user-facing strings are in Chinese. Code, comments and identifiers are in English.
- **TUI imports.** At runtime, `tui.ts` imports only `rpc.ts` and `src/report.ts`. Everything else is a type-only import, because `@opencode/plugin/tui` pulls in Solid and `src/state` pulls in the rule loaders. `src/report.ts` keeps type-only imports for the same reason.
- **RPC schemas.** `rpc.ts` uses plain JSON Schema, with no `effect`. Omit optional output fields instead of setting them to `undefined`. A handler error reaches the client only if the method declares it, which is why `setMode` returns a `locked` error instead of throwing.
- **Built-in rules** (`docs/opencode-safety-policy-builtin-rules.md`):
  - A rule `id` is unique across all files.
  - `description` is the first key of every file under `rules/`.
  - Each rule needs at least 2 `examples.match` and at least 2 `examples.ignore`, one of them containing `echo `. `test/rules-examples.test.ts` runs every example through the real analyzer.
  - The loader rejects unknown fields inside a rule and ignores top-level keys other than `rules`.
  - Adding a rule or a rule file means syncing the docs listed in §3.7 of that guide: design §4.2 and §6, plus the README coverage list and its "内置规则" table.
- **E2E harness** (`test/e2e/harness.ts`):
  - Each `Harness` gets its own temp HOME and XDG root.
  - A mock LLM turns `@@CALL <tool> <json>` lines, built with `directive()`, into tool calls.
  - Any destructive command a test sends must be shadowed by a PATH stub in `STUBS`, which only prints `STUB-EXECUTED`.
  - TUI tests drive a real `opencode` through `@xterm/headless` (`test/e2e/tui-driver.ts`).
  - Unit tests of hooks use `test/helpers/fake-context.ts` instead of OpenCode.
- **Docs** are written in Chinese, with technical terms kept in English. A behavior change updates the README and the design doc together.
- **Commits** use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`) and carry `Signed-off-by`.
- **Releases.** Bump `version` in `package.json` and the version examples in the README, then push a `vX.Y.Z` tag. `release.yml` reruns `ci.yml` and attaches the tgz and `SHA256SUMS`. `nightly.yml` runs CI against the latest `@opencode/cli` and opens one issue per failing OpenCode version.
