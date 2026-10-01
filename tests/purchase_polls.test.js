const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePollSettings, stillEligible, processPurchasePolls } = require('../utils/purchasePollService');
const settings = { question: 'Why?', option1: 'Price', option2: 'Payment', option3: 'Plans', enabled: true, delay_minutes: 15, cooldown_days: 7 };
const now = Date.now();
const booking = { bus_ticket_id: 10, passenger_id: 2, channel: 'web', source_type: 'platform', status: 'cancelled', purchase_poll_expired_at: new Date(now - 1800000).toISOString(), created_at: new Date(now - 7200000).toISOString(), bus_tickets: { operator_id: 1, status: 'active', departure_date: '2099-01-01', departure_time: '10:00:00' } };
const row = { id: 99, user_id: 2, booking_id: 5, telegram_id: '55', question_snapshot: 'Original', options_snapshot: ['A', 'B', 'C', 'Other'] };
test('settings validate lengths, uniqueness, booleans and bounded integer timing', () => {
    assert.ok(validatePollSettings(settings));
    for (const bad of [{ question: '' }, { question: 'x'.repeat(301) }, { option1: 'x'.repeat(101) }, { option2: 'Price' }, { delay_minutes: 0 }, { cooldown_days: '7' }, { enabled: 'true' }]) assert.equal(validatePollSettings({ ...settings, ...bad }), null);
});
test('eligibility excludes unmarked cancellations, manual, paid, blocked and changed owners', () => {
    const user = { telegram_id: 55 };
    assert.equal(stillEligible(booking, row, settings, user, now), true);
    for (const bad of [{ purchase_poll_expired_at: null }, { channel: 'manual' }, { status: 'confirmed' }, { claimed_by_user_id: 3 }, { created_at: '2020-01-01' }]) assert.equal(stillEligible({ ...booking, ...bad }, row, settings, user, now), false);
    assert.equal(stillEligible(booking, row, settings, { telegram_id: 66 }, now), false);
    assert.equal(stillEligible(booking, row, settings, { telegram_id: 55, is_blocked: true }, now), false);
});
function mock({ paid = false, disabled = false, lookupFailure = false, finalFailure = false } = {}) {
    const updates = [], rpcs = [];
    const db = {
        from(table) {
            let confirmed = false;
            return { select() { return this; }, eq(key, value) { if (key === 'status' && value === 'confirmed') confirmed = true; return this; }, or() { return this; },
                single: async () => ({ data: table === 'poll_settings' ? { ...settings, enabled: !disabled } : table === 'users' ? { telegram_id: 55 } : booking, error: lookupFailure && table === 'bus_ticket_bookings' ? {} : null }),
                limit: async () => ({ data: confirmed && paid ? [{ id: 1 }] : [], error: null }),
                update(value) { updates.push(value); return this; }, then(resolve) { resolve({ error: null }); } };
        },
        rpc: async (name, params) => { rpcs.push({ name, params }); return name === 'fn_claim_purchase_polls' ? { data: [row], error: null } : { data: { success: !finalFailure }, error: null }; }
    }; return { db, updates, rpcs };
}
test('dry-run and disabled settings never claim or send', async () => {
    for (const opts of [{ dryRun: true }, { disabled: true }]) {
        const m = mock(opts); let touched = false;
        await processPurchasePolls({ dbClient: m.db, dryRun: opts.dryRun, configure: async () => { touched = true; }, send: async () => { touched = true; } });
        assert.equal(touched, false); assert.equal(m.rpcs.length, 0);
    }
});
test('dispatch uses frozen snapshot and atomically finalizes ledger', async () => {
    const m = mock(); let sentRow;
    const result = await processPurchasePolls({ dbClient: m.db, configure: async () => {}, send: async r => { sentRow = r; return 'test-poll'; } });
    assert.equal(result.sent, 1); assert.equal(sentRow.question_snapshot, 'Original'); assert.equal(m.rpcs[1].name, 'fn_finalize_purchase_poll'); assert.equal(m.updates.length, 0);
});
test('late payment or lookup failure suppresses dispatch', async () => {
    for (const opts of [{ paid: true }, { lookupFailure: true }]) {
        const m = mock(opts); let sent = false;
        await processPurchasePolls({ dbClient: m.db, configure: async () => {}, send: async () => { sent = true; } });
        assert.equal(sent, false); assert.equal(m.updates[0].status, opts.paid ? 'skipped' : 'failed');
    }
});
test('network or finalization ambiguity is marked uncertain, never sent again', async () => {
    for (const opts of [{ finalFailure: true }, {}]) {
        const m = mock(opts);
        const result = await processPurchasePolls({ dbClient: m.db, configure: async () => {}, send: async () => { if (!opts.finalFailure) throw new Error('TIMEOUT'); return 'test-poll'; } });
        assert.equal(result.uncertain, 1); assert.equal(m.updates[0].status, 'uncertain');
    }
});
