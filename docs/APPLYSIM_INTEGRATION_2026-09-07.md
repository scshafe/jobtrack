# Bounded ApplySim integration pass

Later Keychain routing work is recorded separately in
[GOG_KEYCHAIN_ROUTING.md](GOG_KEYCHAIN_ROUTING.md). These historical live-cycle
receipts do not verify the new V3 binary or its post-refresh permissions. Do not
rerun an ApplySim cycle to test the Keychain fix.

Verified September 7–8, 2026 Pacific (September 8 UTC). This records source,
tests and one bounded live cycle. Checkpoints below are chronological; earlier
failures and gates are retained as history, not the current result.

## Current result — first interview booked; send audit incomplete

The one isolated run, `cycle-6f88dd75-f4c7-4278-a252-5f007635d5f5`
(`DRV-58E8163A26`), reached actual URL intake, worker-produced materials,
accepted ApplySim form submission, company mail through Inbox into JobTrack,
a native Gmail draft and approved reply, a reply-backed company confirmation,
and JobTrack interview 1 for application 3. The simulated appointment is
September 11, 2026, 16:00–17:00 UTC: noon–1 p.m. Eastern / 9–10 a.m. Pacific.
No real Calendar event was created.

This is **functional booking success, not a clean end-to-end audit pass**.
The provider physically sent the reply, but a parser rejected its camel-case
acknowledgment before native send evidence and the signed receipt could be
persisted. The durable claim remains fenced; no resend, fence deletion or
fabricated receipt was performed. JobTrack `79c2021` fixes the parser for
future sends and passed focused tests; it does not recover this lost receipt
and has not yet been witnessed in another live send.

The exact simulator run was closed at `2026-09-08T07:53:07.457Z`, preserving
its booking, uploads, claims and history. Temporary read-only observers were
stopped. Standing services, the prior current-run alias and the 15 historical
runs were left unchanged. Local source commits were not pushed or deployed.

Remaining boundaries are authenticated send-receipt reconciliation, failed
reply-intent recovery with conversation supersession, and a subsequent clean
live witness. The initial invitation's failed reply was recorded only as a
transition, so a wake could not recover it; this run advanced on the company's
normal nudge instead. Do not backfill a stale invitation reply after booking.

## Initial implementation checkpoint

- Retired the fixture-backed welcome-draft helper; its compatibility entry
  point now refuses without creating domain/provider evidence.
- Added external draft-only reply and clarification recipes with actual
  source-header retrieval and native Gmail draft create/readback validation.
  Caller-authored reply text is sealed in a separate process without claiming
  a model invocation. Clarification records its real fixed-template origin.
- Kept approval and transmission separate. Clarification resumes an unsent
  proposal and marks a question asked only from an actual sent receipt;
  all candidate application policies remain binding.
- Added durable approval/source-message transmission fences, authenticated
  receipt recovery, strict provider identifiers and delivery binding, and
  atomic signing-key publication. Unknown provider outcomes are reconcile-only.
- Required a hash-pinned, app-local Gmail executable whose mutation transport
  makes one physical attempt. The system executable was not replaced.
- Updated JobTrack and ApplySim worker recipes to use these paths.

Details and operational constraints: [native draft operations](NATIVE_DRAFT_OPERATIONS.md)
and [pinned transport](../tools/gog/README.md).

## Initial verification checkpoint

The final focused JobTrack integration batch passed 76/76 tests. A separate
additional regression batch passed 30/30 tests covering shared submission
signing, outgoing contracts, CLI persistence and web privacy/lifecycle behavior.
These are batch counts, not a claim of distinct tests across all earlier runs.
ApplySim worker-brief tests passed 20/20. Independent cross-review found no
remaining blocking code issue in those boundaries; this was not a full-repo
test run.

The pinned executable was built reproducibly and hash-verified. Its upstream
Google API suite and physical local HTTP tests exercised draft creation and
send, including failed acknowledgements, disconnects and redirects. These tests
used no real mailbox and do not prove a live draft or transmission.

## Initial live gate — historical; authorization subsequently verified

The installed executable can read the designated account's source message.
The pinned executable fails the identical read-only probe. Both resolve the
same account, client, configuration and sanitized environment. Targeted
Keychain access-control metadata inspection showed that the account's three
existing token aliases trust only the Homebrew executable. The pinned path is
not trusted; its dependency masks the access failure as a missing token.

Operator approval is required before adding the exact hash-verified pinned
executable to those existing account aliases while preserving current access.
No token was exported, credential copied, OAuth grant minted or ACL changed.

At 2026-09-08 02:50 UTC, the live ApplySim registry still contained 15 completed
runs and zero active runs. The current-run alias remained `r2609032053474f`.
No fresh run, URL intake, application, native draft or email was initiated by
this pass. Existing history, production mailbox gates and deployments were
left unchanged.

## Initial live-witness criteria — historical

After the narrow access approval and a successful pinned read-only probe,
create one fresh Drove run with `makeCurrent:false`, inject its exact run-scoped
URL through normal JobTrack intake into the isolated ApplySim store, and let
the standing applicant/company workers perform the cycle. The shipped Staff
Software Engineer role is distinct from both historical test roles. Applicant
mail remains restricted to `careers@mydrove.com` from the university account.

Success requires a real application submission, native draft/readback and send
evidence, a reply-linked company scheduling decision of `confirm` (not timeout
`settle`), persisted simulated booking, accepted confirmation email and a
correlated JobTrack interview with time and timezone. Stop only the new run
after that evidence set, or report the exact failed boundary. Do not create an
interview directly or inject facts to manufacture success. No real Calendar
event or production-employer application is in scope.

## September 8 UTC authorization follow-up

Cole explicitly approved the exact three-alias access addition. The new
metadata-only operator utility passed three focused tests and a real dry run.
At 04:23 UTC, fresh readback still showed all three aliases in their original
state: both noninteractive apply and an explicitly interactive background
attempt returned macOS OSStatus `-25308` before the first change. No token was
read, copied or replaced, and no existing trusted application was removed.
The background attempt exited; there is no pending prompt or operation lock.

The remaining operator step is to run the scoped interactive command in
Terminal on the mini's desktop (see the pinned transport runbook). No fresh
ApplySim run or URL intake has been created. A parallel live refresh found
the applicant quiescent, its exact recipient allowlist and unexpired human
submission policy intact, the company registry still at 15 completed/0 active,
and the Inbox relay with zero unresolved claims. Those checks establish
preconditions, not a completed test cycle.

## Desktop application-trust readback and code-identity completion

After Cole reported the desktop command finished, all three token aliases
matched the app-trust plan's exact `after` snapshots. The pinned source-message
probe nevertheless returned `No auth`, while the installed executable with the
same account/client/environment still read the account successfully.

Targeted metadata inspection identified a second restriction left untouched by
the original helper: every `ACLAuthorizationPartitionID` plist contained only
the installed Homebrew binary's CDHash, not the SHA-256-verified pinned
executable's CDHash. Both code identities were checked with
the native `codesign` tool; no credential data was read or copied to diagnose
this restriction.

The `--code-identity` utility scope completes authorization for that same exact
executable on the same three entries. Its separate private plan preserves the
first access change and appends only the pinned CDHash to each partition list;
no broad tool/team partition grant or other account is involved. Native desktop
confirmation and the subsequent actual pinned mailbox read are still required.
No new ApplySim run, intake, application, draft or transmission was initiated.

Five focused utility tests passed, including execution of the real Swift plist
transform for XML/binary formats, preservation of unknown metadata and exact-byte
rollback. Independent review found no blocking issue. The saved code-identity
dry-run plan's `before` snapshots equal the original app-trust `after` snapshots;
an independent comparison confirmed the only proposed difference per alias is
the appended pinned CDHash. Fresh code-identity verification reports all three
aliases still `before`. The completion has not been applied by the agents.

## Code-identity desktop failure: helper API correction

Cole's desktop code-identity apply returned
`KEYCHAIN_AUTHORIZATION_REQUIRED_OR_DENIED_primary`, OSStatus `-25293`.
The saved failure receipt and fresh metadata verification show all three
aliases still exactly `before`; application trust from the earlier step remains.

Apple's source explains a helper defect, not evidence of an incorrect password:
the ordinary `SecKeychainItemSetAccess` path uses prompt credentials, whereas
PartitionID replacement requires database credentials. The native `security
set-generic-password-partition-list` command uses the password-authorized API
and prompts with hidden Terminal input when `-k` is omitted.
Sources: [partition protection](https://github.com/apple-oss-distributions/Security/blob/main/securityd/src/acls.cpp),
[native command](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c).

The correction keeps the same three exact targets and exact pinned CDHash,
private plan/intent/result journal, whole-ACL preflight and post-write checks.
Apple's command rebuilds the partition plist, so native serialization must match
the saved before and after bytes and contain no unknown keys before any write.
A pure metadata comparison passed for all three saved targets. The password is
handled only by Apple's native tool in the operator's terminal; it is never
read into our scripts, captured, or passed in arguments/environment variables.
Code-identity rollback now fails closed rather than attempting the same broken
public API. No new cycle or mailbox mutation was started during this correction.

Verification of the correction: 11/11 focused utility and pinned-executable tests
passed, including execution of the actual native serialization/argument guards.
The corrected helper's read-only `--code-identity --verify` also ran successfully
against the saved live plan: primary, legacy and subject all remain `before`.
These checks are not an authorized native write or successful mailbox-read
witness; Cole's hidden Terminal prompt and subsequent readback are still required.
Independent review also exercised the actual terminal-spawn block with only its
executable replaced in memory by a harmless shell: the child retained the
foreground process group and read a dummy fixture from its terminal. No native
security command or password was involved. This caught and avoids Foundation
`Process`'s separate-process-group behavior on this Mac.

## Native authorization cleared; isolated cycle preparation

Cole's corrected command reports all three aliases changed and verified.
Independent live verification now matches every exact code-identity `after`
snapshot. The pinned draft adapter then successfully read the designated prior
source message: expected sender and thread matched, a real RFC Message-ID was
present and three reference headers were retained. This is a live read witness,
not a native draft/send or full-cycle witness.

Prepared at `2026-09-08T06:23:17.179Z` for exactly one new isolated test:
`cycle-6f88dd75-f4c7-4278-a252-5f007635d5f5`.
Creation/intake are not yet claimed by this preparation record. The intended
route is `/companies/drove/apply?run=cycle-6f88dd75-f4c7-4278-a252-5f007635d5f5`,
using the shipped Staff Software Engineer posting, realistic templates and
proposed interview windows. `makeCurrent:false` must preserve the old current
alias and all historical runs/store rows. Existing human submission constraints,
recipient lock and honest triage remain unchanged; the 8+ year role requirement
may produce a genuine fit-related hold rather than an inflated score.

Live start readback: the run was created with reference `DRV-58E8163A26`,
timezone `America/Indiana/Vevay`, zero sends, and registry membership 16.
All 15 historical entries and the current alias were compared and preserved.
Actual posting text fetched from that run-qualified URL was ingested once at
`2026-09-08T06:24:31.914Z`: opportunity/opening/posting/snapshot 3, opportunity
UUID `e2c350a8-265a-47c5-82f9-00ca45bae582`, no possible duplicates. The committed
wake is 20. The existing daemon began pass
`arc-r2609032053474f-p20260908062432` at `06:24:32.594Z` and dispatched
`opportunity.triage` at `06:24:33.511Z`. The old arc key is its unchanged logging
label, not the company run's routing identity. Read-only filesystem-event
observers now watch this opportunity and exact company run. Dispatch is not
yet proof of triage, submission, email delivery or interview scheduling.

Triage completed on its first real Codex/`gpt-5.6-sol` attempt at
`06:27:03.132Z`, with provider-reported usage evidence (210,866 input and 5,421
output tokens) and no failure/dead letter. It recorded `watch`, score 0.54,
coverage 0.72, no hard blockers, and explicit Staff-level experience gaps.
The unchanged `opportunity.pursue@rev1` policy uses its score threshold 0.50
and therefore promoted application 3 (UUID
`87523bdc-8dc6-4376-83df-6d1e3f224ee9`); no score or gate was edited to force
progress. Research and assessment then completed. Assessment 3 was approved
by `policy:fabric/application.assessment-review@rev2`; existing uncertainty
policy rev3 also ran. Résumé drafting began at `06:33:36.889Z`. There is still
no submission or interview witness at this checkpoint.

The first résumé render (7, revision 14) had two pages and was blocked by
`PAGE_COUNT_EXCEEDS_POLICY` and `SAFETY_VALUE_PRESENT`; it was not uploaded or
sent. The normal revision worker completed without operator intervention.
Render 8 (revision 16) passed lint at `06:43:04Z`, then existing material-review
rev4 and selection rev5 policies approved/selected it. Cover-letter drafting
started at `06:43:06.001Z`. No guard was weakened to clear the first failure.

The first cover-letter render (9, revision 18) was also blocked by
`SAFETY_VALUE_PRESENT`. Its normal revision passed (render 10, revision 20),
and both selected documents formed the package at `06:48:46.695Z`.
The exact run-qualified surface was bound to intent `fabric-intent-3-v1`,
approved by the existing submission policy rev7, and claimed once as
`fabric-attempt-3-v1` at `06:49:13.933Z`. No second attempt was started.

The live form submission produced the company ACK at `06:51:08.026Z`:
SMTP Message-ID `8d207a6857ddaf3a2f7ef458.0@mydrove.com`, with a 250 queue
acceptance. The attempt settled `accepted` at `06:51:53.881Z`. At the
`06:53:25Z` readback, however, the material-submission record was still absent
and the application remained `package_ready`; accepted settlement alone is
not the complete applicant evidence set. The fresh ACK reached JobTrack as
message reference 10 / Gmail `<gmail-id-1>`, but its latest correlation
was ambiguous. These two boundaries are being diagnosed without retrying the
submission or forcing a guessed association. The company invitation is due
no earlier than `07:11:08Z` under its unchanged 20-minute delay.

The pending material boundary closed normally at `06:53:36.964Z`: event 3
references that same accepted attempt and the application is `submitted`.
An optional settlement `evidence_digest` remains null; it is not a requirement
of the current material-record path. The read-only proof helper was corrected
to report the actual accepted-attempt/material-event binding independently.

Inbox admitted the ACK at `06:51:29.477Z`, recorded outbox
`a579ce32-e7d4-4607-b535-40ce450a1bec`, and delivered attempt 1 at
`06:52:21.089Z`. Native Gmail readback matched both `X-ApplySim-Message-ID`
to the company receipt and `X-ApplySim-Reference` to `DRV-58E8163A26`.
The actual RFC Message-ID was rewritten by SES; original-ID equality alone
would not establish the delivery chain.

The three normal review workers retired the ACK independently for applications
1, 2 and 3. Application 3's decision was not successful handling: it recorded
`none` after the worker reported a Keychain source-read timeout.
The agent did not guess a link. The pass then quiesced with the ACK still
ambiguous, which exposes a transport-failure-versus-final-decision gap.
Root's pinned native reads of the exact same Gmail message succeeded.
The worker read path is under diagnosis; no direct link or re-submission was
performed to hide this failure.

Source reconciliation also found that the reply helper already appends a
conversation reference when Inbox supplies a uniquely grounded `bracket_code`
through `source.conversationReference`. The upcoming invitation includes such
a reference in its body. Its actual extraction and actual reply still need
verification; the separate legacy `live-bridge` harness must not be used as a
mapping-only repair because it also classifies and mutates JobTrack state.

The new external `read-email-source.cjs` path uses the same pinned executable,
explicit client and sanitized environment as the native draft adapter. A live
read at `07:10:44Z` returned the exact ACK's body in approximately 0.3 seconds,
with account/message/thread/sender checks passing. This proves the operator-side
reader, not yet its execution inside a new model worker. ApplySim's review and
reply recipes now name this reader; successful source read is a prerequisite
for any ambiguity or handling decision. Reader failures must stay unresolved.

The original worker timeout's physical cause remains unproven: its ephemeral
tool-level trace was not retained. Source/config checks establish distinct
Homebrew-versus-pinned read paths, not which underlying Keychain operation
failed. Identical correlation is deduplicated, and there is no clean public
reopen operation for the ACK's historical `none` decision. The ACK remains
unlinked as an explicit residual rather than deleting or rewriting history.

At `07:11:10.371Z`, the company sent invitation `p1`, SMTP Message-ID
`15863863673080d2e667a337.1@mydrove.com`, with a 250 queue acceptance.
Both company claims are settled sent; there is still no applicant reply,
negotiation decision or booking witness at this checkpoint.

Reader correction is committed locally as JobTrack `642145d`; ApplySim's
successful-read prerequisite and pinned reader recipes are `da5ded8`.
Root's combined reader/adapter/reply/clarification suite passed 34/34, the
ApplySim worker suite passed 22/22, and independent review verified the MIME
attachment-fallback regression. The final reader passed another actual ACK
read after that fix. These local commits were not pushed or deployed to the
laptop; the mini's existing worker reads the corrected local sources.

Invitation delivery identity was independently verified: Gmail
`<gmail-id-2>` has both exact native custom headers for the send/run.
Inbox admitted unit
`email-unit:8f30ae2ef94e15803d4d5ad93055785f851abb9cd09f30b6f4aef07c5877b00a`
at `07:11:37.032Z`. Filter/security/route settled; classification reserved at
`07:11:45.965Z`. At `07:18:26Z`, its worker and model-capacity leases were
still renewed, but no JobTrack outbox existed yet. The physical invocation
path and timeout are under source-backed diagnosis; an empty provider-attempt
table alone is not evidence that the configured direct-model route never ran.

The deployed source does wrap that route in the MC substrate; provider journal
admission occurs only after the grant. Exact `payload.queueId` lookup bound
the classification to MC work `b859251e-b9b1-4674-b4a9-239b972114f9`, graph
`7d76f91b-09dd-47df-8a4e-ca5606ab2319`, created `07:11:46.945Z` and completed
`07:23:04.883Z`. Provider admission was `07:22:57.000957Z`, with roughly
eight seconds of physical work. Its 180-second physical timeout does not
cover the preceding grant wait; healthy leases can sustain that wait without
a cumulative deadline.

Inbox then recorded outbox `d61995d6-3557-4b96-9a7b-e69299d90022`; attempt 1
delivered at `07:23:41.829Z` with no error, as JobTrack message reference 11 /
correlation 25. Actual stored facts contain the expected bracket code and
matching body evidence; executing `clarificationReference` on those facts
returned `DRV-58E8163A26`. Root's final native reader also successfully read
the exact invitation and found its Staff role and run reference. The normal
applicant pass began at `07:23:42.470Z`; no operator-made link, draft or send
was introduced to advance it.

The scheduler delay is now established by its actual hold log:
`awaiting_residency: 1`, with the previous Mistral residency held until the
default 1,800-second dwell expired. No competing lease occupied the host
during the invitation's wait. The scheduler policy was not changed.

The new review workers reported successful source reads and ruled out the
two historical applications. Worker 3 resolved invitation 11 to application 3
(correlation 26), then moved it to `interviewing`. A naturally changed
correlation basis subsequently re-offered ACK 10 through the ordinary flow;
it is now actively linked too (correlation 28). The original failed decision
remains in history; no explicit reopen or history rewrite was used.

Reply preparation created proposal
`external-reply-4c839041902151d87c058701f7f939ce:proposal` at `07:28:29.843Z`,
but stopped with `GOG_DRAFT_INVALID_ID` before creating a native draft.
The exact native operation had no prepared/creating journal. Actual pinned,
read-only baseline enumeration found 131 drafts across two pages, zero on this
invitation's thread, and legitimate opaque draft IDs containing `:` that the
generic identifier check rejected. Provider-name differences in stored versus
sealed representations were inspected and were not the cause.

JobTrack `d2efe96` adds a draft-only validator at list/create-ACK/readback.
Message/thread/operation identity checks, baseline-before-create ordering,
pagination bounds and uncertain-create safeguards are unchanged. Regression
now passes the real CLI and separate sealer into the real native adapter,
faking only provider subprocess responses. Root's combined suite passed 34/34;
independent targeted review passed 29/29. After the normal eight-minute retry
interval elapsed, one supported CLI wake (25, socket ping succeeded) requested
the existing daemon resume at `07:39:53Z`. No direct native create/send or new
application attempt was issued by the operator agent.

Wake 25 ran normally but staffed no worker. Readback explains why: decision 19
for invitation 11 was recorded as `transition`, with an explicit reason that
the selected-slot reply could not be sent due to `GOG_DRAFT_INVALID_ID`.
No `job_email_reply_attempts` row was recorded. The outstanding-reply projection
therefore does not treat this failure as a reply owed. This is a distinct
failure-intent/recovery gap, not another draft-ID failure or a cooldown override.
The decision was not rewritten. Creating an old-message retry after a later
message resolves the conversation would also need a supersession rule, not
just another wake.

At `07:41:12.651Z`, the company sent its normal unanswered-invitation nudge,
`045b1581bca14832d71cd948.2@mydrove.com` (`neg-1`, `scheduling_nudge`).
Its negotiation action is `nudge` with null reply Message-ID; booking is null.
This is not an interview-confirmation witness. The fresh follow-up can use
the corrected reader and draft-ID adapter through the normal delivery/review
flow; no synthetic follow-up or manually fabricated reply was introduced.

## Native nudge reply and post-send acknowledgment failure

Inbox admitted the nudge at `07:41:41.210Z`; outbox
`78670d21-0b3d-4c89-b51e-322ed693adfc` delivered on attempt 1 at
`07:42:29.391Z`. Its Gmail message/thread is `<gmail-id-3>`, JobTrack
message reference 12, linked to application 3 by latest correlation 29.
It is not an explicit `active_job_email_application_links` row: final evidence
queries include the latest linked correlation as well as active links.

The ordinary worker created proposal
`external-reply-cf707fd31fd61fa67f7e2f28e33a1adb:proposal` at `07:43:38.783Z`.
Native draft `r-<draft-id>` was read back at `07:43:42.790Z` and
recorded with receipt
`external-reply-cf707fd31fd61fa67f7e2f28e33a1adb:native-receipt`.
Signed approval `auto-approval-7504555a2b9affa2a3f7b56b` followed at
`07:43:51.192Z`. The single-attempt sender durably claimed request
`send-req-134b4bd8fa89da649ef965f4` at `07:44:05.148Z`.

The actual applicant reply arrived at `07:44:06Z`, RFC Message-ID
`<CAFd-DJVa8S1M4MT6XEayxgoPr7JZ6hOmC94=bZbpKU--8GTdcw@mail.gmail.com>`.
The worker nevertheless reported `SEND_RECONCILIATION_REQUIRED` and did not
retry. The native journal contains the claim only: no `provider-evidence.json`
or `receipt.json`. The associated database send request/receipt transaction
rolled back. The draft and approval remain recorded, but are not substitutes
for authenticated transmission evidence.

Pinned upstream source and a parser-fixture reproduction establish that the
Gmail transport emits `{messageId, threadId}`, while the sender accepted `id` /
`message_id`, not `messageId`. This mismatch explains the observed post-send
failure before provider-evidence persistence; the original acknowledgment
bytes were not retained. This was the gated sender path with a lost
acknowledgment, not a send bypass. Company receipt
and its reply-backed decision independently establish delivery; they do not
reconstruct the missing native acknowledgment or signed receipt.

JobTrack `79c2021` accepts the pinned camel-case shape alongside the supported
legacy/nested shapes, requires present aliases to agree, and retains strict
message/thread identity validation. Root's sender suite passed 22/22;
independent review also passed 22/22. These are overlapping batch counts and
test evidence, not a new live-send witness. The claim-only attempt remains
reconcile-only under the existing recovery contract; rerunning the corrected
sender is not an authorized way to recover it.

## Reply-backed booking and persisted first interview

At `07:44:13.806Z`, the company's round-1 action was `confirm`, with
`replyMessageId` equal to the actual applicant RFC Message-ID above. It booked
slot `2026-09-11T12:00`, start `2026-09-11T16:00:00.000Z`, end
`2026-09-11T17:00:00.000Z`, in `America/Indiana/Vevay`. This is not the
unanswered-invitation `settle` fallback.

Confirmation SMTP send `f476199154f35ac24e3fc05a.3@mydrove.com` settled at
`07:44:15.280Z`. Native Gmail message `<gmail-id-4>`, on thread
`<gmail-id-3>`, has the exact company send/run custom headers. Its body
was independently read and verified to identify September 11, noon EDT,
and `DRV-58E8163A26`. The company durable decision supplies the explicit
applicant-reply binding; native confirmation reply headers do not themselves
contain that applicant RFC Message-ID.

Inbox admitted the confirmation at `07:44:31.054Z`; outbox
`ca534d2b-6b0f-4305-8bff-ad3c5a1a7698` delivered on attempt 1 at
`07:45:15.795Z`. JobTrack reference 13 / correlation 30 linked it to application
3. The normal worker applied `agent-transition-13-create_interview` at
`07:46:24Z`, recording transition event 23, scheduled interview event 1 and
interview 1 (`40807e23-c085-4225-afad-547d20242a6b`). Its source is
`gmail_gog:<university-account>:<message-id>`; round `final`, format `video`,
scheduled start `2026-09-11T16:00:00.000Z`, timezone `America/New_York`.
The EDT parser's New York mapping and the simulator's Vevay zone agree on
this instant; the email body did not name either IANA timezone.

The worker recognized the confirmation as requiring no reply, despite the
stored extracted facts unexpectedly carrying `replyRequested:true` while
the company emitted false. No extra applicant send followed. This extraction
discrepancy is a follow-up, not evidence of a second scheduling reply.

## Bounded shutdown and preserved evidence

After the real reply-backed booking and persisted interview were verified,
the exact run was marked `complete` at `07:53:07.457Z` (revision 13) through
the deployed `withRunPassLeasesSync` / `setRunStatus` path. Guards checked
the exact run, reference and account, non-null reply-backed confirmation,
booking and all four settled-sent company claims. Readback confirmed the
scheduling, sends and claims were unchanged by closure. The status marks
the bounded simulator's termination, not a clean audit result.

The previous current-run alias `r2609032053474f` remained unchanged, including
SHA-256 `6bda4d9a3fb2feb096d9c68d660c4ec689ee167d8804b142f9ffdc19f1055b8b`.
All 15 pre-existing historical index entries were preserved. No uploads,
history or database rows were deleted. All temporary read-only observers
were stopped/reaped; no standing applicant, relay or company service was
restarted or stopped. No second cycle or resend was initiated.

The remaining recovery work must preserve the uncertain-send fence and avoid
resurrecting the earlier failed invitation after a later message resolved the
conversation. The current `transition`-only failure loses reply intent, while
the retry model lacks conversation-level supersession; simply recording an
old failed attempt or using `skipped` (which only delays retry) is not a safe
repair. This run's missing receipt remains explicitly unresolved.

## September 9 source-only recovery follow-up

The bounded implementation in [EMAIL_REPLY_RECOVERY.md](EMAIL_REPLY_RECOVERY.md)
adds immutable reply intent independent of handling, a durable pre-send barrier,
and explicit digest-bound same-thread supersession review. Shared JobTrack/ApplySim
worker briefs now record intent before drafting and a new barrier before the one
separately authorized send. Classifiers, new mail and handling decisions cannot
automatically retire intent; supersession never clears reconciliation. Synthetic
tests cover signed-receipt rollback recovery, uncertain-send duplicate prevention,
cross-application ambiguity, historical unbound-send holds and blocked visibility
through terminal states/retractions. No historical backfill or live repair ran.

This is not a clean-run acceptance result or a resolution of this run's missing
receipt. Existing signed-journal recovery needs authentic already-persisted proof;
general missing-provider-proof intake/adoption and cross-thread supersession remain
unimplemented. Source rollout, installed-skill proposals and any live reconciliation
still require their separate release/operator boundaries.
