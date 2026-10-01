const router = require('express').Router();
const { internalServiceAuth } = require('../utils/internalServiceAuth');
const { getServiceRoleClient } = require('../dbServiceRole');
router.use(internalServiceAuth);
router.post('/answer', async (req, res) => {
    const b = req.body || {};
    if (typeof b.telegram_id !== 'string' || !/^\d{1,20}$/.test(b.telegram_id)) return res.status(400).json({ error: 'INVALID_RECIPIENT' });
    let name, params;
    if (b.action === 'vote') {
        if (typeof b.poll_id !== 'string' || b.poll_id.length > 200 || !Number.isInteger(b.option) || b.option < 0 || b.option > 3) return res.status(400).json({ error: 'INVALID_VOTE' });
        name = 'fn_answer_purchase_poll'; params = { p_poll_id: b.poll_id, p_telegram_id: b.telegram_id, p_option: b.option };
    } else if (b.action === 'text') {
        if (typeof b.text !== 'string' || b.text.length > 10000) return res.status(400).json({ error: 'INVALID_TEXT' });
        name = 'fn_answer_purchase_poll_text'; params = { p_telegram_id: b.telegram_id, p_text: b.text };
    } else return res.status(400).json({ error: 'INVALID_ACTION' });
    try {
        const { data, error } = await getServiceRoleClient().rpc(name, params);
        if (error) throw error;
        res.json(data);
    } catch (_) { res.status(503).json({ error: 'POLL_SAVE_FAILED' }); }
});
module.exports = router;
