# OSON SMS — Manual Booking Automatic Ticket Delivery
## Implementation & Gate Report

Branch: `feature/oson-manual-booking-sms` (backend + frontend, both from `origin/main`)
Status: **local commits only — not pushed, not merged, not deployed**
No real SMS, no real Telegram messages, no production DB/env changes were made.

---

## 1. Root cause

Carriers create passenger bookings manually in the carrier cabinet, but nothing
automatically hands the passenger a link to their ticket. The passenger never
opens the app, never starts the Telegram bot, and their Telegram account never
gets linked to the booking — so post-purchase notifications and re-engagement
stay dependent on the carrier remembering to forward a link by hand.

## 2. Architecture

```
carrier creates manual booking (POST /bus-admin/bookings/manual)
   → bus_ticket_bookings row (status=confirmed, claim_status=unclaimed)
   → IF already Telegram-linked by phone match → auto-claim (unchanged, pre-existing)
   → ELSE IF OSON_SMS_ENABLED && past rollout cutoff && carrier allowlisted:
        enqueue ONE row in manual_booking_sms_outbox (idempotency_key = booking+template)
        [http response returns — nothing sent yet]

runMaintenanceTick (existing cron, "maintenance.yml") — every tick:
   → processManualBookingSmsOutbox()
        → fn_claim_manual_booking_sms_batch() [FOR UPDATE SKIP LOCKED + lease]
        → for each claimed row: re-check booking is still confirmed & unclaimed live
        → check daily / per-phone / per-carrier caps
        → generate claim session (claimHelper.generateClaimSession) AT SEND TIME ONLY
        → render RU/TJ/UZ template with https://poputki.online/t/<rawToken>
        → osonSmsClient.sendServiceSms() [HTTPS-only, single attempt, fail-closed]
        → mark sent / retry / dead_letter / cancelled

passenger opens https://poputki.online/t/<token> (new, public, no auth)
   → ClaimLandingView.vue calls existing POST /api/claims/preview-trip
   → shows non-PII trip summary only — does NOT reveal full ticket, does NOT
     auto-confirm the phone
   → one button → https://t.me/Poputkionline_bot?start=claim_<token>
   → EXISTING bot claim_ flow (unchanged): request_contact → verify-and-claim
     → Telegram account linked to the booking
```

Nothing here duplicates existing machinery: the outbox/worker pattern, the
claim-session token, and the `/preview-trip` endpoint are all reused from
code that was already in production use for the trip-change and bot-claim
flows. The only new pieces are OSON-specific (transport, templates, caps)
plus one new outbox table and one new thin landing page.

## 3. Old PHP OSON contract — found, without secrets

Source: the account's own historical PHP integration (`osonsms.php`, one
class file, audited in an earlier turn of this session) plus osonsms.com's
public documentation (fetched where the sandbox's network policy allowed —
`osonsms.com` itself is blocked by this environment's egress proxy, so this
is triangulated from search-engine snippets and a Packagist/GitHub PHP
wrapper, not the primary PDF).

| Item | Found |
|---|---|
| Endpoint | `sendsms_v1.php` (GET). Historical code used `http://api.osonsms.com/...`; public docs show `https://api.osonsms.com/...` exists. This client **only** accepts the HTTPS form — see `ERR_INSECURE_TRANSPORT` in `osonSmsClient.js`. |
| Auth params | `login`, `hash` (secret) — both present in the historical code, **not printed anywhere in this session's output or files**, referenced only as env var names (`OSON_SMS_LOGIN`, `OSON_SMS_HASH`) |
| Signing | `str_hash = SHA256("jam"+txn_id+";"+login+";"+sender+";"+phone+";"+hash)` — reproduced in `computeStrHash()`, unit-tested against an independently computed value |
| Sender | historical code used `Poputki` as a literal — **not independently reconfirmed as the currently-active Sender ID on the account**; must be verified before go-live (see §12/§13) |
| Success response | `{status:"ok", txn_id, msg_id, smsc_msg_id, smsc_msg_status, smsc_msg_parts}` |
| Error response | `{error:{code, msg}}` (inferred from the historical wrapper's generic error path) |
| Balance / delivery-status endpoint | **Not found** in the one audited PHP file; a `getBalance()`/`getSMSStatus()` method exists in third-party PHP/Laravel OSON wrapper packages (confirms the capability exists on OSON's side) but the concrete endpoint URL was not independently confirmed |
| Countries | Only `992...` (Tajikistan) format is documented anywhere found; RU/UZ/KZ support is **not confirmed** |
| Current protocol version | A newer public protocol snippet mentions `Authorization: Bearer` auth, distinct from the login+hash scheme this account's code actually uses — **this needs OSON to confirm which scheme is live for this specific account** before enabling delivery |

**OSON CONTRACT: BLOCKED** — not because the client is unfinished, but
because live confirmation (sender ID, Bearer-vs-hash auth, country support,
current secret) requires either OSON support contact or a live read-only
account check, and this sandbox's network egress to `osonsms.com` is
blocked, and no such live check was authorized/attempted per the task's own
"не отправлять send" and "не выполнять если раскрывает credential" rules.

## 4. Changed files

Backend (`poputki-backend`, branch `feature/oson-manual-booking-sms`, commit `7940a78`):
- `docs/migrations/20260908_manual_booking_sms_outbox.sql` (new)
- `utils/osonSmsClient.js` (new)
- `utils/smsTemplates.js` (new)
- `utils/osonSmsCaps.js` (new)
- `utils/manualBookingSmsOutboxService.js` (new)
- `utils/maintenanceHelper.js` (modified — added task to `runMaintenanceTick`)
- `routes/busAdmin.js` (modified — added outbox enqueue after manual booking creation)
- `tests/phase_oson_sms_outbox.test.js` (new, 31 tests)
- `.env.example` (modified — documented new env vars, no real values)

Frontend (`poputki-front`, branch `feature/oson-manual-booking-sms`, commit `d5da2cb`):
- `src/views/ClaimLandingView.vue` (new)
- `src/router/index.js` (modified — `/t/:token` route, added to `publicRoutes`)

No changes to `poputki-bot` (existing `claim_` deep-link handling is reused unchanged).

## 5. Migration

`docs/migrations/20260908_manual_booking_sms_outbox.sql`
SHA-256: `7d16d4718df0a5e09a581907898cf53c427b431527a56e7dcc2947b6078241da`

Purely additive: one new table (`manual_booking_sms_outbox`) + one new RPC
(`fn_claim_manual_booking_sms_batch`). Does not `ALTER` any existing table
— zero blast radius on the existing Telegram/WhatsApp routing engine, the
trip-change outbox, or the claim/handoff flow. **Not applied to production.**

## 6. Unit test results

```
node --test "tests/**/*.test.js"
# tests 1271
# suites 193
# pass 1271
# fail 0
```

Ran the **entire** existing backend suite, not just the new file — zero
regressions from the `busAdmin.js` / `maintenanceHelper.js` changes. (Initial
run showed 41 unrelated failures across the whole suite caused by this sandbox
having no `.env` at all — `SUPABASE_URL`/`SUPABASE_ANON_KEY` are required at
module-load time by `db.js` even for fully-mocked tests. Created a local,
git-ignored `.env` with placeholder/dummy values — no real credentials — to
let the existing suite run at all; confirmed this is pre-existing environment
setup, not something introduced by this change.)

New suite: `tests/phase_oson_sms_outbox.test.js`, 31/31 passing, covering:
client success/HTTP-error/200-with-error-body/timeout/invalid-JSON,
secret redaction, phone/login masking, `str_hash` correctness, HTTPS
enforcement, invalid phone, unsupported country, dry-run, delivery-disabled,
segmentation (GSM-7 vs UCS-2), all three locale templates, daily/per-phone/
per-carrier caps, carrier allowlist, kill switch, cancelled-booking skip,
already-claimed skip (no duplicate vs. Telegram), no-phone dead-letter.

**Deliberately not covered as unit tests** (mocked query builders cannot
meaningfully prove these — see §7 instead): FOR UPDATE SKIP LOCKED
concurrency, lease expiry/recovery, the `idempotency_key` UNIQUE constraint,
rollout-cutoff gating at the route level (verified by code review only —
the check is a straightforward date comparison in `busAdmin.js`, not
independently route-tested this pass), token-expiry/cross-booking-claim
(unchanged, pre-existing, already covered by this repo's own claim tests).

## 7. PostgreSQL Integration Gate — real local Postgres 16

Applied `docs/migrations/staging/00_staging_schema_baseline.sql` then the new
migration to a fresh local database (`oson_gate_test`), both cleanly, no
errors, with the actual `anon`/`authenticated`/`service_role` roles created
to match Supabase's real role model.

- **Idempotency**: inserting a second row with the same `idempotency_key`
  via `ON CONFLICT (idempotency_key) DO NOTHING` — 0 rows inserted, exactly
  1 row remains for the booking. **PASSED.**
- **Concurrency (FOR UPDATE SKIP LOCKED)**: opened an uncommitted transaction
  that claimed all 4 pending rows and held the transaction open; a second,
  concurrent claim call while those locks were held returned **0 rows**.
  **PASSED** — proves two worker instances can never double-claim the same
  row.
- **Lease expiration/recovery**: manually backdated one row's
  `lease_expires_at` into the past with `status='processing'` (simulating a
  crashed worker) — a fresh claim call picked up exactly that one row
  (`attempts_count` incremented 1→2), leaving the other 3 still-valid-lease
  rows untouched. **PASSED.**

**POSTGRES GATE: PASSED.**

## 8. Idempotency — verified

Both at the DB level (§7, UNIQUE constraint) and the worker level (an
already-`claimed` booking is skipped with `ALREADY_CLAIMED_SKIP_SMS`, never
double-delivered — unit-tested, §6).

## 9. Concurrency — verified

§7. Real Postgres, real locking, not simulated.

## 10. SMS segment calculation (RU/TJ/UZ)

Computed by `smsTemplates.calculateSmsSegments()` (GSM-7 default alphabet
check → UCS-2 fallback), unit-tested. With a real 32-hex-char claim token
and a short route (`Душанбе → Худжанд`):

| Locale | Encoding | Chars | Segments |
|---|---|---|---|
| ru | UCS-2 (Cyrillic) | ~95 | 2 (70 chars/segment) |
| tj | UCS-2 (Cyrillic) | ~100 | 2 (70 chars/segment) |
| uz | GSM-7 (Latin) | ~90 | 1 (160 chars/segment) |

Exact counts depend on the real city names and final token length — the
calculator itself is exact and tested; these are representative examples,
**not final approved copy**. Final wording and per-message cost need
explicit sign-off (§13) before go-live, per the task's own instruction.

## 11. Render env vars needed (names only, no values)

```
OSON_SMS_ENABLED
OSON_SMS_DELIVERY_ENABLED
OSON_SMS_DRY_RUN
OSON_SMS_BASE_URL
OSON_SMS_LOGIN
OSON_SMS_HASH
OSON_SMS_SENDER
OSON_SMS_TIMEOUT_MS
OSON_SMS_ALLOWED_COUNTRIES
OSON_SMS_DAILY_CAP
OSON_SMS_PER_PHONE_DAILY_CAP
OSON_SMS_PER_CARRIER_DAILY_CAP
OSON_SMS_CARRIER_ALLOWLIST
OSON_SMS_ROLLOUT_STARTED_AT
OSON_SMS_PHONE_HASH_SECRET
```
(`OSON_SMS_HASH` must be a **newly rotated** value in OSON's dashboard — the
value shown to me earlier in this session is to be treated as compromised
and was never written to any file, test, or log.)

## 12. Pilot plan (not started)

1. Apply the migration to a **staging** Supabase project first (never
   directly to production) and re-run the Postgres gate there.
2. Confirm with OSON support (out of band, not from this sandbox): current
   auth scheme (hash vs Bearer), the Sender ID actually approved for this
   account, and account status/balance.
3. Set `OSON_SMS_CARRIER_ALLOWLIST` to exactly one pilot carrier's user id.
4. Set `OSON_SMS_ROLLOUT_STARTED_AT` to a timestamp at/after go-live —
   guarantees the 159+ pre-existing bookings are never touched, since the
   enqueue check compares against this cutoff at booking-creation time.
5. Set `OSON_SMS_DAILY_CAP=5`, `OSON_SMS_PER_PHONE_DAILY_CAP=1`.
6. `OSON_SMS_ENABLED=true`, `OSON_SMS_DRY_RUN=true`, `OSON_SMS_DELIVERY_ENABLED=false`
   first — confirm the outbox rows appear and reach `status=sent` (dry-run)
   for one internal test booking with one internal test phone number.
7. Only after explicit separate go-ahead: `OSON_SMS_DRY_RUN=false`,
   `OSON_SMS_DELIVERY_ENABLED=true` — exactly one real booking, one real
   internal phone number, confirm one real SMS arrives, then pause
   (`OSON_SMS_ENABLED=false`) and review before widening.

## 13. Rollback plan

- Kill switch: `OSON_SMS_ENABLED=false` (env-only, no deploy, no DB change)
  stops the worker from claiming anything within one maintenance tick.
- If a migration was applied to staging/production and needs reverting:
  `DROP FUNCTION public.fn_claim_manual_booking_sms_batch; DROP TABLE public.manual_booking_sms_outbox;`
  — safe because nothing else references this table (purely additive
  migration, confirmed in §5).
- No existing table, column, RLS policy, or route was altered, so there is
  nothing else to roll back on the booking/claim/notification path.

## 14. Verdicts

```
CODE GATE:           PASSED   (1271/1271 existing + new tests pass, zero regressions)
POSTGRES GATE:       PASSED   (idempotency, concurrency, lease recovery — real local PG 16)
OSON CONTRACT:       BLOCKED  (sender ID / auth scheme / country support / balance
                                 endpoint not independently reconfirmed — osonsms.com
                                 egress is blocked from this sandbox; needs OSON support
                                 contact or an authorized live check from an environment
                                 that can reach it)
PRODUCTION DELIVERY: NOT ENABLED
```

No push, no merge, no deploy, no production DB or env changes, no real SMS,
no real Telegram messages, no real WhatsApp messages were made or sent.

## Appendix: WhatsApp readiness (audit only, per Stage 11)

Not implemented this pass. From the earlier general audit of this codebase
(prior turn), `WhatsAppProvider` already exists as an explicit stub
(`canSend()` always `false`, reason `WHATSAPP_BUSINESS_API_NOT_CONFIGURED`)
and the `channel` CHECK constraint on `bus_ticket_notification_outbox`
already allows `'sms'` as a value even though no send logic exists for it
there. Whether the account holds a WhatsApp Business **app** (mobile-only,
no server API) or the Meta WhatsApp Business **Platform/Cloud API** (WABA ID,
Phone Number ID, access token, approved Utility template, webhook
verification) was **not established** — this needs the account owner to
check Meta Business Manager, not something inferable from code. If it turns
out to be the mobile app only, per the task's own instruction, automated
server-side WhatsApp sending is **not available** and no unofficial
WhatsApp Web automation should be built.
