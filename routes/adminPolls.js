const router = require('express').Router();
const { getServiceRoleClient } = require('../dbServiceRole');
const { validatePollSettings, processPurchasePolls } = require('../utils/purchasePollService');
// Mounted after adminAuth. Never access these tables through an anonymous client.
router.get('/settings', async (req, res) => {
    try {
        const { data, error } = await getServiceRoleClient().from('poll_settings').select('*').eq('id', 1).single();
        if (error) throw error; res.json(data);
    } catch (_) { res.status(500).json({ error: 'Не удалось загрузить настройки опроса' }); }
});
router.put('/settings', async (req, res) => {
    const settings = validatePollSettings(req.body || {});
    if (!settings) return res.status(400).json({ error: 'Укажите вопрос до 300 символов, три разных ответа до 100 символов и допустимые интервалы отправки.' });
    try {
        const { data, error } = await getServiceRoleClient().from('poll_settings').update(settings).eq('id', 1).select().single();
        if (error) throw error; res.json(data);
    } catch (_) { res.status(500).json({ error: 'Не удалось сохранить настройки опроса' }); }
});
router.get('/answers', async (req, res) => {
    const page = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) return res.status(400).json({ error: 'INVALID_PAGE' });
    try {
        const { data, error, count } = await getServiceRoleClient().from('purchase_poll_answers')
            .select('id,booking_id,user_id,telegram_id,answer,created_at,question_snapshot,users:user_id(name,phone),bus_ticket_bookings:booking_id(id,total_price,passenger_count,seat_numbers,bus_tickets:bus_ticket_id(from_city,to_city,departure_date,departure_time))', { count: 'exact' })
            .order('created_at', { ascending: false }).order('id', { ascending: false }).range((page - 1) * 20, page * 20 - 1);
        if (error) throw error; res.json({ answers: data || [], count: count || 0, page, page_size: 20 });
    } catch (_) { res.status(500).json({ error: 'Не удалось загрузить ответы' }); }
});
router.post('/trigger', async (req, res) => {
    try { res.json({ success: true, ...await processPurchasePolls({ dryRun: req.query.dry_run === 'true' }) }); }
    catch (_) { res.status(503).json({ success: false, error: 'POLL_DISPATCH_FAILED' }); }
});
router.get('/recipients', async (req, res) => {
    const page = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) return res.status(400).json({ error: 'INVALID_PAGE' });
    try {
        const { data, error, count } = await getServiceRoleClient().from('purchase_poll_recipients')
            .select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false })
            .range((page - 1) * 20, page * 20 - 1);
        if (error) throw error;
        res.json({ recipients: data || [], count: count || 0, page, page_size: 20 });
    } catch (_) { res.status(500).json({ error: 'Не удалось загрузить получателей опросов' }); }
});
router.get('/status', async (req, res) => {
    try {
        const db = getServiceRoleClient();
        const states = ['sent', 'failed', 'uncertain', 'skipped', 'processing'];
        const counts = {};
        for (const status of states) {
            const result = await db.from('purchase_poll_outbox').select('id', { count: 'exact', head: true }).eq('status', status);
            if (result.error) throw result.error; counts[status] = result.count || 0;
        }
        const [sent, answered] = await Promise.all([
            db.from('purchase_poll_recipients').select('id', { count: 'exact', head: true }).eq('delivery_status', 'sent'),
            db.from('purchase_poll_recipients').select('id', { count: 'exact', head: true }).eq('delivery_status', 'sent').eq('answer_status', 'answered')
        ]);
        if (sent.error || answered.error) throw sent.error || answered.error;
        counts.sent_total = sent.count || 0;
        counts.answered_total = answered.count || 0;
        counts.awaiting_total = Math.max(0, counts.sent_total - counts.answered_total);
        res.json({ ...counts, webhook_ready: require('../utils/purchasePollService').isWebhookReady() });
    } catch (_) { res.status(500).json({ error: 'Не удалось загрузить состояние отправки' }); }
});
module.exports = router;
