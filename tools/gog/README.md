# App-local, single-attempt Gmail transport

Current routing/upgrade runbook: [GOG_KEYCHAIN_ROUTING.md](../../docs/GOG_KEYCHAIN_ROUTING.md).
V3 retains V2's exact-account metadata command and adds process-local native
Keychain no-interaction enforcement for `--no-input`. All three patches are
pinned; the original transport patch is unchanged. It is a separate
artifact, not an in-place replacement. Credential calls are on an operational
hold during prompt-storm containment. The current rollout is blocked on native
authorization and post-refresh live verification; the older receipts below are
historical and must not be replayed for V3.

Keep the credential hold while first stopping admissions and draining legacy
callers; see the runbook's corrected cutover sequence before any live test.
JobTrack workers use `umich-bin/gog` with an intentional university default.
OpenClaw main instead uses `main-bin/gog`, which requires an explicit approved
account and currently supports only the university route. Personal routing is
not enabled or restored yet; no account discovery or Homebrew fallback is allowed.

External JobTrack draft/send adapters require this pinned build. They must not
fall back to PATH, Homebrew gog, an environment override, or an unverified file.
The installed system CLI and its credentials are not replaced or copied.

Upstream is gogcli v0.27.1 at the exact commit in `pin.json`. Its original retry
transport repeated replayable POST requests on 429 and 5xx. The narrow patch
keeps GET/HEAD/OPTIONS retry behavior while making other methods single-attempt:
no application retry, no `GetBody` hooks for Go HTTP/1 or HTTP/2 replay, no
idempotency replay headers, and no redirect response reaches `http.Client`.
OAuth refresh can occur before the request; a provider 401 is not retried.

The patch includes physical local HTTP tests using the actual generated Gmail
draft-create and send APIs through OAuth. A simulated committed mutation followed
by 401/429/500/502/503, a disconnect, or a redirect never produces another
physical mutation. No real mailbox or credential is used by these tests.

Build on the mini with an explicit, clean upstream checkout at the pinned commit:

```sh
node scripts/build-pinned-gog.cjs /absolute/path/to/gogcli
```

The script verifies upstream, all three patches, toolchain, all `internal/googleapi` tests,
and focused `TestJobTrackInspectAccount` / `TestJobTrackNoninteractiveKeychain` tests,
and the resulting binary SHA-256 before an exclusive app-local install under
`.tools/gog/`. Only darwin-arm64 is currently reviewed. Other platforms and
different toolchain results fail closed and require their own reviewed pin.
The compiler/SDK are recorded because this build uses CGO for macOS Keychain.
`resolvePinnedGog()` checks provenance and executable hash again on every use.

Building does not grant Keychain access. On the mini, the existing account
token's access-control list can trust only the Homebrew executable; this new
executable then reports `No auth` even though the account/token exists. Check
account metadata and access-control metadata before requesting a new OAuth
grant. An operator must approve access for the exact hash-verified app-local
executable to the intended account's existing token aliases (primary, legacy
and subject identity, which the CLI updates together on refresh). Preserve all existing
trusted applications and other ACL entries; never enable access for all apps,
copy/export the token, or replace the system executable as a workaround.

A successful read-only account/source-message probe using the pinned executable
is required before starting a live cycle. Build tests and the installed CLI's
working credentials do not establish that this executable can access them.

This does not make Gmail mutations idempotent. Missing acknowledgement still
requires reconciliation, never re-creation or re-send. Draft and sender journals
retain that operation fence independently of the transport. The binary is a
local build artifact, not an enrolled service or an automatically updated tool.

## Operator-approved Keychain access

The narrowly scoped `scripts/authorize-pinned-gog-keychain.cjs` utility targets
only the university account's three existing token aliases. It defaults to a
metadata-only dry run and never reads, copies or replaces token values. The
default application-trust scope preserves existing trusted application objects,
owner, authorization tags, descriptions, prompt selectors and every other ACL.
Before/after metadata and operation receipts are stored privately outside
version control. Use a separate private receipt directory for each scope.

```sh
node scripts/authorize-pinned-gog-keychain.cjs --dry-run \
  --receipt-dir ~/.mission-control/projects/jobtrack/.tools/gog/keychain-acl-20260908
node scripts/authorize-pinned-gog-keychain.cjs --verify \
  --receipt-dir ~/.mission-control/projects/jobtrack/.tools/gog/keychain-acl-20260908
```

After explicit operator approval, `--apply` adds only the pinned executable.
Default execution refuses if macOS requires interaction. For application trust,
`--interactive` is accepted only with `--apply`; it allows the native Security framework dialog
for that process and removes its timeout. It neither answers the dialog nor
unlocks the Keychain or changes host interaction settings. If a background or
SSH session returns OSStatus `-25308`, run from Terminal on the mini's desktop:

```sh
cd ~/.mission-control/projects/jobtrack
~/.openclaw/tools/node/bin/node scripts/authorize-pinned-gog-keychain.cjs --apply --interactive --receipt-dir ~/.mission-control/projects/jobtrack/.tools/gog/keychain-acl-20260908
```

Enter any required password only into the native macOS dialog, never chat or
CLI arguments. A failure must be followed by `--verify`, which reports each
alias as `before`, `after` or `mismatch` without changing access. Do not blindly
retry or broaden trust. Explicit `--rollback` removes only this addition and
refuses unrelated ACL drift; it is not run automatically. Keep the saved plan
for recovery. A successful ACL update is still not a mailbox-operation witness:
repeat the pinned source-message read before the live test.

Do not edit these same Keychain ACLs concurrently while an authorization prompt
is open. The utility performs optimistic preflight and post-write verification,
not a native atomic compare-and-swap against other Keychain editors.

### Complete the code-identity restriction

macOS checks two distinct restrictions on these entries: the trusted-application
list and `ACLAuthorizationPartitionID`. The first utility version changed only
the application list. Live verification showed the partition list still allowed
only the Homebrew code hash, so adding the pinned path alone did not grant access.

After application trust is present, `--code-identity` completes the same exact
executable authorization in a separate, scope-bound plan. It verifies both the
binary SHA-256 and its code-signing CDHash, then appends only
the current pin's exact CDHash to the three existing partition
lists. Existing partitions, trusted applications and other ACL metadata remain
intact. Native application refuses unknown plist fields or serialization changes
instead of silently discarding them. It cannot select an arbitrary hash/account or add
broad `apple:`, `apple-tool:` or `teamid:` grants.

The original code-identity apply used `SecKeychainItemSetAccess`, which cannot
replace a protected PartitionID ACL without database credentials. Cole's desktop
attempt returned `-25293`; all three entries remained unchanged. That error did
not establish an incorrect password. Apple's native `security` command uses
the required password-authorized API instead. See its
[implementation](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c).

The corrected helper requires explicit `--apply --interactive` and a controlling
terminal for this scope. It invokes only `/usr/bin/security
set-generic-password-partition-list` with an exact account, service and keychain
for each alias. No `-k` argument is supplied. Apple prompts in Terminal with hidden
input, authorizes/unlocks the login keychain, and updates the partition ACL;
neither Node nor Swift receives the password. Native metadata stdout is discarded.
Before the first write, all three saved plans must be compatible with Apple's
serialization; each write still requires exact before/after metadata checks.

Run the completion command in Terminal on the mini's desktop:

```sh
cd ~/.mission-control/projects/jobtrack
~/.openclaw/tools/node/bin/node scripts/authorize-pinned-gog-keychain.cjs --code-identity --apply --interactive --receipt-dir ~/.mission-control/projects/jobtrack/.tools/gog/keychain-code-identity-20260908
```

Enter the login Keychain password only at Apple's hidden Terminal prompt, never
in chat, arguments or environment variables. Expect a prompt for each remaining
alias. Stop on error; inspect with `--verify` before considering any retry.

Use `--code-identity --dry-run` to inspect and `--code-identity --verify` to read
back against that same receipt directory. After completion, this newer plan is
the complete ACL witness. The original app-trust plan will report `mismatch`
because it deliberately still pins the old partition list; do not weaken its
comparison to hide that expected change. Automated code-identity rollback is
disabled: it needs the same password-authorized native operation, not the old
public API. Keep the private plan; an operator-reviewed native rollback must
remove only the added hash and restore the exact original description bytes,
then verify the entire ACL against the saved `before` snapshots. The pure
reverse transformation remains tested but is not a live rollback witness.
No live cycle may start until a pinned source-message read succeeds.
If an operator requests rollback of both scopes, reverse their application
order: code identity first, then application trust. Neither rollback is automatic.
