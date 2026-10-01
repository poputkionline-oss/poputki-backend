'use strict';
const crypto = require('crypto');
const axios = require('axios');
const { getServiceRoleClient } = require('../dbServiceRole');
const CUSTOM_OPTION = 'Свой вариант (напишите ответ)';
let webhookReady = false;
function validatePollSettings(body) {
    const fields = ['question', 'option1', 'option2', 'option3'];
    if (fields.some((key, i) => typeof body[key] !== 'string' || !body[key].trim() || [...body[key].trim()].length > (i ? 100 : 300))) return null;
    const result = Object.fromEntries(fields.map(key => [key, body[key].trim()]));
    if (new Set([result.option1, result.option2, result.option3, CUSTOM_OPTION].map(s => s.toLowerCase())).size !== 4) return null;
    result.enabled = body.enabled ?? true;
    result.event_type = body.event_type ?? 'purchase';
    if (!['purchase', 'completed'].includes(result.event_type)) return null;
    result.delay_minutes = body.delay_minutes ?? 15;
    result.cooldown_days = body.cooldown_days ?? 7;
    if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.delay_minutes) || result.delay_minutes < 1 || result.delay_minutes > 1440 || !Number.isInteger(result.cooldown_days) || result.cooldown_days < 1 || result.cooldown_days > 365) return null;
    return result;
}
function webhookSecret(token) { return crypto.createHash('sha256').update('poputki-polls-webhook-v1:' + token).digest('hex'); }
async function configurePollWebhook() {
    if (webhookReady) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('BOT_NOT_CONFIGURED');
    const url = `https://api.telegram.org/bot${token}`;
    const { data: info } = await axios.get(url + '/getWebhookInfo', { timeout: 10000 });
    if (!info?.ok || !info.result?.url?.startsWith('https://')) throw new Error('WEBHOOK_NOT_CONFIGURED');
    const updates = info.result.allowed_updates;
    const payload = { url: info.result.url, secret_token: webhookSecret(token), drop_pending_updates: false };
    // Empty/absent allowed_updates means Telegram's default set already includes polls.
    if (Array.isArray(updates) && updates.length) payload.allowed_updates = [...new Set([...updates, 'poll_answer', 'message'])];
    const { data } = await axios.post(url + '/setWebhook', payload, { timeout: 10000 });
    if (!data?.ok) throw new Error('WEBHOOK_SETUP_FAILED');
    const recorded = await getServiceRoleClient().from('poll_settings').update({ webhook_configured_at: new Date().toISOString(), webhook_url: info.result.url }).eq('id', 1);
    if (recorded.error) throw new Error('WEBHOOK_AUDIT_FAILED');
    webhookReady = true;
}
async function sendPurchasePoll(row) {
    const { data } = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPoll`, {
        chat_id: row.telegram_id, question: row.question_snapshot,
        options: row.options_snapshot.map(text => ({ text })), is_anonymous: false,
        allows_multiple_answers: false, allows_revoting: false, protect_content: true
    }, { timeout: 10000 });
    if (!data?.ok || !data.result?.poll?.id) throw new Error('POLL_SEND_UNCONFIRMED');
    return data.result.poll.id;
}
function stillEligible(booking, row, settings, user, now = Date.now()) {
    if (!settings?.enabled || !booking || !user || user.is_blocked || String(user.telegram_id) !== row.telegram_id) return false;
    const owner = booking.claimed_by_user_id ?? booking.passenger_id;
    const trip = booking.bus_tickets;
    if (owner !== row.user_id || booking.channel === 'manual' || booking.source_type === 'manual' || booking.contact_role === 'carrier_contact' || trip?.operator_id === owner) return false;
    const event = row.event_type || 'purchase';
    if (event !== (settings.event_type || 'purchase')) return false;
    if (event === 'completed') {
        const completedAt = trip?.poll_completed_at ? new Date(trip.poll_completed_at).getTime() : NaN;
        return trip?.status === 'completed' && booking.status === 'confirmed' && booking.boarding_status === 'boarded'
            && completedAt >= now - 86400000 && completedAt <= now - settings.delay_minutes * 60000;
    }
    if (trip?.status !== 'active') return false;
    if (new Date(booking.created_at).getTime() < now - 86400000) return false;
    const expiration = booking.status === 'cancelled' ? (booking.purchase_poll_expired_at ? new Date(booking.purchase_poll_expired_at).getTime() : NaN)
        : (booking.status === 'pending_payment' ? new Date(booking.hold_expires_at || new Date(new Date(booking.created_at).getTime() + 1800000)).getTime() : NaN);
    return Number.isFinite(expiration) && expiration <= now - settings.delay_minutes * 60000;
}
async function processPurchasePolls({ dbClient = null, send = sendPurchasePoll, configure = configurePollWebhook, dryRun = false } = {}) {
    const db = dbClient || getServiceRoleClient();
    if (dryRun) return { dry_run: true, sent: 0 }; // no claims or Telegram calls
    const { data: settings, error: settingError } = await db.from('poll_settings').select('*').eq('id', 1).single();
    if (settingError) throw settingError;
    if (!settings.enabled) return { disabled: true, sent: 0 };
    // Configure origin authentication before any actual poll can be dispatched.
    await configure();
    const { data: rows, error } = await db.rpc('fn_claim_purchase_polls', { p_limit: 5 });
    if (error) throw error;
    const counts = { sent: 0, skipped: 0, failed: 0, uncertain: 0 };
    for (const row of rows || []) {
        let status = 'skipped';
        try {
            const bResult = await db.from('bus_ticket_bookings').select('*,bus_tickets!inner(status,operator_id,departure_date,departure_time,poll_completed_at)').eq('id', row.booking_id).single();
            const uResult = await db.from('users').select('telegram_id,is_blocked').eq('id', row.user_id).single();
            const sResult = await db.from('poll_settings').select('*').eq('id', 1).single();
            if (bResult.error || uResult.error || sResult.error) throw new Error('LOOKUP_FAILED');
            const b = bResult.data;
            const { data: paid, error: paidError } = await db.from('bus_ticket_bookings').select('id').eq('bus_ticket_id', b.bus_ticket_id).eq('status', 'confirmed')
                .or(`claimed_by_user_id.eq.${row.user_id},and(claimed_by_user_id.is.null,passenger_id.eq.${row.user_id})`).limit(1);
            if (paidError) throw paidError;
            const trip = b.bus_tickets;
            const departure = new Date(`${trip.departure_date}T${trip.departure_time}+05:00`).getTime();
            const eventEligible = row.event_type === 'completed' || (departure > Date.now() && !paid?.length);
            if (stillEligible(b, row, sResult.data, uResult.data) && eventEligible) {
                status = 'uncertain'; // network or ledger ambiguity: never automatically resend
                const pollId = await send(row);
                const finalized = await db.rpc('fn_finalize_purchase_poll', { p_outbox_id: row.id, p_poll_id: pollId });
                if (finalized.error || !finalized.data?.success) throw new Error('FINALIZATION_FAILED');
                counts.sent++; continue;
            }
        } catch (_) { if (status !== 'uncertain') status = 'failed'; }
        const saved = await db.from('purchase_poll_outbox').update({ status, lease_expires_at: null, last_error: status === 'uncertain' ? 'DELIVERY_UNCONFIRMED' : (status === 'failed' ? 'LOOKUP_FAILED' : null) }).eq('id', row.id).eq('status', 'processing');
        if (saved.error) throw saved.error;
        counts[status]++;
    }
    return counts;
}
module.exports = { validatePollSettings, webhookSecret, configurePollWebhook, processPurchasePolls, stillEligible, isWebhookReady: () => webhookReady };
