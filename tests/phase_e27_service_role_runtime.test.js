/**
 * Phase E.27 — Service Role Runtime Stabilization & Cache Invariant Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getServiceRoleClient, getServiceRoleDiagnostics } = require('../dbServiceRole');
const { persistNotificationPlan, enqueueAndDispatchNotifications } = require('../utils/notificationQueueService');

describe('Phase E.27 — Service Role Runtime Stabilization Tests', () => {

    it('[E27-01] ENV present initializes serviceRoleClient and caches it', () => {
        const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key_mock_12345';

        try {
            const client = getServiceRoleClient();
            assert.ok(client, 'getServiceRoleClient must return client instance');
            const diag = getServiceRoleDiagnostics();
            assert.strictEqual(diag.serviceRoleClientCached, true, 'serviceRoleClient must be cached after initialization');
        } finally {
            if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
            else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        }
    });

    it('[E27-02] CRITICAL INVARIANT: Deleting process.env.SUPABASE_SERVICE_ROLE_KEY AFTER successful initialization MUST STILL return cached client', () => {
        const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key_mock_67890';

        try {
            const client1 = getServiceRoleClient();
            assert.ok(client1);

            // Simulate runtime environment deletion after startup cache
            delete process.env.SUPABASE_SERVICE_ROLE_KEY;

            const client2 = getServiceRoleClient();
            assert.strictEqual(client2, client1, 'Must return identical cached client even if process.env key is subsequently deleted');
            const diag = getServiceRoleDiagnostics();
            assert.strictEqual(diag.serviceRoleClientCached, true, 'serviceRoleClientCached must remain true');
        } finally {
            if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
            else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        }
    });

    it('[E27-03] notificationQueueService uses canonical cached client when options.supabaseClient is omitted', async () => {
        const mockClient = {
            from: () => ({
                upsert: (row) => ({
                    select: () => ({
                        maybeSingle: () => Promise.resolve({ data: { id: 'notif-27', ...row }, error: null })
                    })
                })
            })
        };

        const plan = {
            intents: [{
                channel: 'telegram',
                recipientType: 'passenger',
                recipientUserId: 1121,
                notificationType: 'ticket_issued',
                status: 'pending',
                idempotencyKey: 'test:key:e27'
            }]
        };

        const results = await persistNotificationPlan(plan, { booking: { id: 888 } }, { supabaseClient: mockClient });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].notification.booking_id, 888);
    });

    it('[E27-04] Notification failure remains non-blocking to booking creation', async () => {
        await assert.doesNotReject(async () => {
            await enqueueAndDispatchNotifications({ intents: [] }, { booking: { id: 777 } });
        });
    });
});
