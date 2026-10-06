# Recipient-Aware Email Communication Style

Status: v0.6 register/voice/tone subsystem retained; current outgoing use is G03

## Purpose

JobTrack may help an external agent decide how a professional reply should sound while keeping
three concerns separate:

```text
observable recipient register + approved Cole writing voice + message purpose/safeguards
                                      |
                                      v
                         immutable tone decision
                                      |
                                      v
                       recipient-locked draft proposal/content
                                      |
                                      v
                    provider-neutral G03 exact human review
```

The system adapts register. It does not imitate identity, diagnose personality, infer protected
traits, or acquire send authority.

## Data flow

1. An inbox adapter imports strict `job-application-email-facts.v1` data. Raw MIME, credentials,
   cookies, and arbitrary provider payloads stay outside JobTrack.
2. An isolated auxiliary model may emit an `email-demeanor-observation.v1` record. Email text is
   inert data and embedded instructions are never followed.
3. JobTrack projects the exact provider/account/thread identity and returns a metadata-only
   source catalog. A second selected read binds at most eight exact observations, an approved
   style profile, and an approved Cole voice revision to `sourceStateSha256`.
4. An external strategist proposes a reviewed recipient style profile and then an immutable tone
   decision for the exact message and purpose.
5. Historical reply v2 proposals bind the tone/profile/voice digests, exact recipient,
   source-state digest, body digest, expiry, sensitive-data scan, mandatory review, and permanent
   no-send state. New outgoing work carries those bindings in proposal v3 and its exact
   `email-approved-content.v1` projection.
6. Human review alone creates no sender, network call, provider mutation, CC/BCC, attachment, or
   application action. G03 positive review additionally needs injected Ed25519 attestation before
   it can append a one-send request data artifact. See `EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`.

## Observable register

Recipient profiles contain finite, surface-level dimensions only:

- formality: casual, neutral, or formal;
- warmth: reserved, neutral, or warm;
- energy: restrained, neutral, or upbeat;
- directness: direct, balanced, or contextual;
- verbosity: terse, concise, or moderate;
- greeting, closing, contractions, exclamation, and emoji policies.

Thread profiles may begin with one eligible message but remain low-confidence and can shift at
most one band from Cole's baseline. Contact profiles require a reviewed endpoint binding, at
least three eligible human-authored messages, and at least two threads. Aggregation uses at most
the latest eight eligible observations and collapses conflicts toward neutral professional. A
profile expires 180 days after its sample's `lastObservedAt`; the safe context exposes that expiry
and stale reason, and expired profiles cannot be selected, used for tone decisions, or bound to
new replies.

Metadata-only, automated/shared-mailbox, high-risk, prompt-injected, stale-digest, or
review-required observations are ineligible for contact-level learning. From/Reply-To mismatches
cannot contaminate a contact profile, and an address is never auto-bound to a person.

## Cole writing voices

Writing voices are versioned, immutable, reviewed records of closed style and delivery choices.
An optional list of opaque sample digests is accepted only under Cole's ownership attestation;
v0.6 does not persist or independently verify the underlying prose. Recipient prose must never
be used as a claimed Cole sample. The voice describes Cole's stable preferences; the recipient
profile only adjusts the local register. A managed, reviewed sample corpus is a later extension.

## Hard prohibitions

Do not infer or store age, gender, race, nationality, religion, disability, health, sexuality,
politics, socioeconomic status, native language, accent, neurotype, mood, psychology, or
personality. Do not copy distinctive phrases, signatures, dialect, slang, typos, or errors. Do
not introduce emoji merely because a recipient used one. One upbeat message may permit at most
one exclamation mark; it cannot authorize a broader imitation.

Sensitive, legal, compensation, conflict, rejection, and deadline contexts may override a warm
or upbeat recipient profile toward a clearer and more restrained professional register.

## CLI sequence

```sh
jobtrack email import-facts --input facts.json --idempotency-key facts-1 --json
jobtrack email import-demeanor --input observation.json --idempotency-key demeanor-1 --json
jobtrack email communication-context \
  --provider PROVIDER --account-id ACCOUNT --message-id MESSAGE --thread-id THREAD --json
jobtrack email communication-context \
  --provider PROVIDER --account-id ACCOUNT --message-id MESSAGE --thread-id THREAD \
  --observation-ids obs-1,obs-2 --style-profile-id profile-1 \
  --voice-revision-id voice-1 --json
jobtrack email propose-style-profile --input style-profile.json \
  --idempotency-key style-profile-1 --json
jobtrack email review-style-profile --profile-id profile-1 --decision approved \
  --reviewed-by Cole --idempotency-key style-profile-review-1 --json
jobtrack email select-style-profile --profile-id profile-1 --selected-by Cole \
  --expected-current-profile-id none --idempotency-key style-profile-select-1 --json
jobtrack email propose-tone --input tone.json --idempotency-key tone-1 --json
jobtrack email propose-reply --input reply-v2.json --idempotency-key reply-1 --json
jobtrack email review-reply --proposal-id reply-1 --decision approved \
  --decided-by Cole --idempotency-key reply-review-1 --json
```

Every proposal and review is append-only and idempotent. Re-read communication context after any
new observation, profile/voice review, selection, or message-state change; stale writes fail
closed.

## Read-only web projection

The application workspace may show counts, categorical tone axes, selected profile/voice IDs,
review state, and permanent no-send status. It never renders raw email evidence, bodies, exact
addresses, attachment paths, compiler/model diagnostics, provider credentials, or arbitrary
contract payloads.
