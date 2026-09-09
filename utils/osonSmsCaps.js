/**
 * osonSmsCaps.js
 *
 * Cost/abuse protection for the manual-booking SMS outbox: daily global cap,
 * per-phone daily cap, per-carrier daily cap, and a carrier allowlist gate
 * for the pilot phase. Pure read-then-decide checks against
 * manual_booking_sms_outbox — no writes here.
 * Project: POPUTKI.ONLINE
 */

'use strict';

const crypto = require('crypto');

function hmacPhone(phone) {
    const secret = process.env.OSON_SMS_PHONE_HASH_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('OSON_SMS_PHONE_HASH_SECRET_MISSING');
    }
    return crypto.createHmac('sha256', secret).update(String(phone)).digest('hex');
}

function startOfTodayUtcIso(now = new Date()) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
}

function readCap(envName, fallback) {
    const raw = process.env[envName];
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * @param {Object} params
 * @param {Object} params.dbClient - service-role Supabase client
 * @param {string} params.phone - normalized recipient phone (not masked)
 * @param {number|null} params.carrierId
 * @param {string|null} [params.outboxId] - the specific outbox row being
 *   evaluated. REQUIRED for the atomic RPC path to actually close the
 *   concurrency race (see fn_oson_sms_check_cap's reservation step,
 *   docs/migrations/20260909185016_manual_booking_sms_ticket_delivery.sql)
 *   — without it the check only serializes the count, not the decision, which two DIFFERENT
 *   concurrent rows can both pass before either has sent anything.
 * @param {Date} [params.now]
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function checkSendCaps({ dbClient, phone, carrierId, outboxId = null, now = new Date() }) {
    const dailyCap = readCap('OSON_SMS_DAILY_CAP', 0); // fail-closed default: 0 = nothing allowed until explicitly set
    const perPhoneCap = readCap('OSON_SMS_PER_PHONE_DAILY_CAP', 1);
    const perCarrierCap = readCap('OSON_SMS_PER_CARRIER_DAILY_CAP', 0);

    if (dailyCap <= 0) {
        return { allowed: false, reason: 'DAILY_CAP_NOT_CONFIGURED' };
    }

    // Atomic path: fn_oson_sms_check_cap serializes the whole check-AND-
    // reserve across ALL concurrent worker processes via
    // pg_advisory_xact_lock, closing the check-then-act race a plain COUNT
    // query (or a count-only lock with no reservation) cannot prevent under
    // multiple workers evaluating DIFFERENT rows at once. Falls back to the
    // non-atomic per-query path only for mock test clients that don't
    // implement .rpc() (unit tests inject those on purpose — the real
    // concurrency guarantee is proven separately against a real Postgres
    // instance, see docs/oson-sms-audit-report.md).
    if (typeof dbClient.rpc === 'function') {
        const phoneHmac = phone ? hmacPhone(phone) : null;
        const { data, error } = await dbClient.rpc('fn_oson_sms_check_cap', {
            p_outbox_id: outboxId,
            p_phone_hmac: phoneHmac,
            p_carrier_id: carrierId || null,
            p_daily_cap: dailyCap,
            p_per_phone_cap: perPhoneCap,
            p_per_carrier_cap: perCarrierCap
        });
        if (error) {
            return { allowed: false, reason: 'CAP_CHECK_FAILED' };
        }
        return data && data.allowed
            ? { allowed: true }
            : { allowed: false, reason: (data && data.reason) || 'CAP_CHECK_FAILED' };
    }

    const sinceIso = startOfTodayUtcIso(now);

    const { count: globalCount, error: globalErr } = await dbClient
        .from('manual_booking_sms_outbox')
        .select('id', { count: 'exact', head: true })
        .in('status', ['sent', 'delivered'])
        .gte('sent_at', sinceIso);

    if (globalErr) {
        return { allowed: false, reason: 'CAP_CHECK_FAILED' };
    }
    if ((globalCount || 0) >= dailyCap) {
        return { allowed: false, reason: 'DAILY_CAP_EXCEEDED' };
    }

    if (phone) {
        const phoneHmac = hmacPhone(phone);
        const { count: phoneCount, error: phoneErr } = await dbClient
            .from('manual_booking_sms_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('recipient_phone_hmac', phoneHmac)
            .in('status', ['sent', 'delivered'])
            .gte('sent_at', sinceIso);

        if (phoneErr) {
            return { allowed: false, reason: 'CAP_CHECK_FAILED' };
        }
        if ((phoneCount || 0) >= perPhoneCap) {
            return { allowed: false, reason: 'PER_PHONE_DAILY_CAP_EXCEEDED' };
        }
    }

    if (carrierId && perCarrierCap > 0) {
        const { count: carrierCount, error: carrierErr } = await dbClient
            .from('manual_booking_sms_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('carrier_id', carrierId)
            .in('status', ['sent', 'delivered'])
            .gte('sent_at', sinceIso);

        if (carrierErr) {
            return { allowed: false, reason: 'CAP_CHECK_FAILED' };
        }
        if ((carrierCount || 0) >= perCarrierCap) {
            return { allowed: false, reason: 'PER_CARRIER_DAILY_CAP_EXCEEDED' };
        }
    }

    return { allowed: true };
}

/**
 * Pilot-phase allowlist: comma-separated carrier (users.id) list in
 * OSON_SMS_CARRIER_ALLOWLIST. Empty/unset => nobody is allowed (fail closed),
 * matching "allowlist перевозчиков для пилота" from the spec.
 */
function isCarrierAllowlisted(carrierId) {
    const raw = process.env.OSON_SMS_CARRIER_ALLOWLIST || '';
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return false;
    return ids.includes(String(carrierId));
}

module.exports = {
    hmacPhone,
    startOfTodayUtcIso,
    checkSendCaps,
    isCarrierAllowlisted
};
