# OSON SMS — Contract Reconciliation Form

Fill in the **"OSON confirmed"** column once the account owner has an
answer from OSON's own cabinet, official documentation, or official
support response (per the task's evidentiary rule: cabinet / docs /
support only — the historical PHP client is corroborating evidence, not a
substitute for one of those three). Do **not** put any credential value in
this file — names/status only, exactly like `.env.example`.

Once filled in, hand this back so `utils/osonSmsClient.js` and
`docs/oson-sms-audit-report.md` §7–8 can be updated to match and the
`OSON CONTRACT` / `OSON TLS GATE` / `OSON CREDENTIAL` verdicts can move
from `BLOCKED` to `VERIFIED`/`READY`.

| # | Item | Implementation assumes (current code) | OSON confirmed (fill in) | Match? |
|---|---|---|---|---|
| 1 | HTTPS endpoint (full URL) | `https://api.osonsms.com/sendsms_v1.php` (env `OSON_SMS_BASE_URL`) — plausible from public search snippets, never fetched from a primary source | | ☐ Y ☐ N |
| 2 | HTTP method | `GET`, all params in the query string | | ☐ Y ☐ N |
| 3 | Content-Type (if request has a body) | N/A — no body, GET only | | ☐ Y ☐ N |
| 4 | Auth transport | `login` + `str_hash` (SHA-256 of `"jam"+txn_id+";"+login+";"+sender+";"+phone+";"+hash`) as query params — the account's own historical scheme. **A newer public doc snippet mentions `Authorization: Bearer <token>` instead — confirm which is actually live for this account.** | | ☐ hash-based ☐ Bearer ☐ other: _____ |
| 5 | `login` parameter name | `login` | | ☐ Y ☐ N |
| 6 | Approved Sender ID | `Poputki` (historical literal, unconfirmed as currently active) | | ☐ Y ☐ N — actual value: __________ |
| 7 | +992 (Tajikistan) support | Assumed yes, `992XXXXXXXXX` digits-only format | | ☐ Y ☐ N |
| 8 | +7 (Russia) support | **Not enabled by default** (`OSON_SMS_ALLOWED_COUNTRIES=TJ`); code has a `7` prefix table entry ready but untested against the real API | | ☐ Y ☐ N — do not add `RU` to `OSON_SMS_ALLOWED_COUNTRIES` until this is `Y` |
| 9 | Success response shape | `{"status":"ok", "txn_id":..., "msg_id":..., "smsc_msg_id":..., "smsc_msg_status":..., "smsc_msg_parts":...}` (from the account's own historical code comment) | | ☐ Y ☐ N — actual shape: __________ |
| 10 | Error response shape | `{"error":{"code":..., "msg":...}}` (inferred, not directly observed) | | ☐ Y ☐ N — actual shape: __________ |
| 11 | `msg_id` field name/type | `msg_id`, treated as required for a send to count as successful (client will NOT accept a bare `{"status":"ok"}` with no `msg_id`) | | ☐ Y ☐ N — actual field name: __________ |
| 12 | Delivery-status endpoint or callback | **Not found** — this implementation never sets `delivered` status anywhere, only `sent` | | ☐ endpoint: __________ ☐ callback/webhook: __________ ☐ none exists |
| 13 | Balance/account-status endpoint | **Not found** — third-party wrapper packages expose a `getBalance()` method, confirming *some* capability exists, but no URL was found | | ☐ endpoint: __________ |
| 14 | Rate limits (requests/sec, requests/day) | Not found anywhere accessible | | value: __________ |
| 15 | Pricing — Tajikistan (per SMS) | Not found | | value: __________ |
| 16 | Pricing — Russia (per SMS, if +7 is supported) | Not found | | value: __________ |
| 17 | Message length / segmentation rules (GSM-7 vs UCS-2, per-segment cost) | This implementation applies the universal GSM-7/UCS-2 standard (`smsTemplates.calculateSmsSegments`) — confirm OSON bills the same way, not a custom scheme | | ☐ Y ☐ N |

## Sign-off

- [ ] Filled in by: ______________________  Date: __________
- [ ] `OSON_SMS_HASH` rotated in OSON's dashboard (new value, never the one referenced in this session's earlier turns) and stored **only** as a Render Secret Environment Variable
- [ ] New value never pasted into chat, code, tests, or any Markdown file
- [ ] Reviewed against `utils/osonSmsClient.js` for any needed code change (e.g. switching from hash-based to Bearer auth) **before** `OSON_SMS_ENABLED` is ever set to `true` anywhere outside a local dry-run test
