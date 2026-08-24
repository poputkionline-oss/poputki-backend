/**
 * Phase 1 Tests: Trip Link Generation, Referral Attribution & Security Validation
 * POPUTKI.ONLINE - Cabinet V3 Phase 1
 */

const assert = require('assert');

// Helper to simulate deep link generator
function generateTripLinks(ticketId, carrierId) {
    return {
        web: `https://www.poputki.online/bus-ticket/${ticketId}?source=carrier_link&ref=c_${carrierId}`,
        bot: `https://t.me/Poputkionline_bot?start=bus_${ticketId}_c${carrierId}`
    };
}

// Helper to simulate Telegram bot /start bus_ parameter parser
function parseBotStartParam(rawParam) {
    if (!rawParam || !rawParam.startsWith('bus_')) return null;
    const parts = rawParam.split('_');
    const busId = parts[1];
    let refToken = null;
    if (parts.length > 2) {
        refToken = parts.slice(2).join('_');
    }
    return { busId, refToken };
}

// Helper to simulate router Telegram start_param parser & sessionStorage storage
function simulateRouterParamHandling(startParam) {
    const sessionStorageMock = {};
    if (startParam && startParam.startsWith('bus_')) {
        const parts = startParam.split('_');
        const busTicketId = parts[1];
        let refCarrierId = null;
        if (parts.length > 2) {
            refCarrierId = parts.slice(2).join('_');
        }
        if (busTicketId) {
            const attribution = {
                channel: 'telegram',
                source_type: refCarrierId ? 'carrier_link' : 'direct',
                source_id: refCarrierId ? refCarrierId.replace(/^c_?/, '') : null,
                timestamp: Date.now()
            };
            sessionStorageMock[`booking_attribution_${busTicketId}`] = JSON.stringify(attribution);
            return {
                route: `/bus-ticket/${busTicketId}`,
                attribution,
                sessionStorage: sessionStorageMock
            };
        }
    }
    return null;
}

// Helper to simulate BusTicketDetailsView query parameter attribution capture
function simulateDetailsViewCapture(ticketId, query) {
    const sessionStorageMock = {};
    const { source, ref, channel } = query;
    let attribution = null;
    if (source || ref || channel) {
        attribution = {
            channel: channel === 'telegram' ? 'telegram' : 'web',
            source_type: source === 'carrier_link' ? 'carrier_link' : (source === 'partner_link' ? 'partner_link' : 'direct'),
            source_id: ref ? String(ref).replace(/^c_?/, '') : null,
            timestamp: Date.now()
        };
    } else {
        attribution = {
            channel: 'web',
            source_type: 'direct',
            source_id: null,
            timestamp: Date.now()
        };
    }
    sessionStorageMock[`booking_attribution_${ticketId}`] = JSON.stringify(attribution);
    return { attribution, sessionStorage: sessionStorageMock };
}

// Helper to simulate Backend /create-invoice attribution validation and anti-spoofing logic
function validateAndSanitizeBookingAttribution(inputAttribution, ticket) {
    const validChannels = ['web', 'telegram', 'manual'];
    const validSources = ['direct', 'carrier_link', 'partner_link', 'manual', 'bot', 'platform'];

    let rawChannel = (inputAttribution && inputAttribution.channel) ? String(inputAttribution.channel).trim().toLowerCase() : 'web';
    let rawSourceType = (inputAttribution && inputAttribution.source_type) ? String(inputAttribution.source_type).trim().toLowerCase() : 'direct';
    let rawSourceId = (inputAttribution && inputAttribution.source_id) ? String(inputAttribution.source_id).trim() : null;

    let cleanChannel = validChannels.includes(rawChannel) ? rawChannel : 'web';
    let cleanSourceType = validSources.includes(rawSourceType) ? rawSourceType : 'direct';
    let cleanSourceId = rawSourceId ? rawSourceId.slice(0, 100) : null;

    // Strict Anti-Spoofing: Carrier Link attribution must match ticket.operator_id
    if (cleanSourceType === 'carrier_link') {
        const parsedSourceId = parseInt(cleanSourceId, 10);
        if (!cleanSourceId || isNaN(parsedSourceId) || parsedSourceId !== ticket.operator_id) {
            // Mismatch or invalid: reset attribution to direct to prevent false attribution
            cleanSourceType = 'direct';
            cleanSourceId = null;
        }
    }

    return {
        channel: cleanChannel,
        source_type: cleanSourceType,
        source_id: cleanSourceId,
        created_by_user_id: null // Online bookings never have created_by_user_id
    };
}

// Helper to simulate Backend /bookings/manual attribution logic
function createManualBookingAttribution(reqCarrier, clientInput) {
    // Client cannot override attribution for manual bookings
    const carrierId = reqCarrier.carrier_id || reqCarrier.id;
    return {
        channel: 'manual',
        source_type: 'manual',
        source_id: String(carrierId),
        created_by_user_id: reqCarrier.user_id
    };
}

console.log('--- STARTING PHASE 1 AUTOMATED TESTS ---\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`[PASS] Scenario ${totalTests}: ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`[FAIL] Scenario ${totalTests}: ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

// Scenario 1: Generation of Web Deep Link with Attribution
runTest('Generation of Web Deep Link with correct params', () => {
    const links = generateTripLinks(45, 12);
    assert.strictEqual(links.web, 'https://www.poputki.online/bus-ticket/45?source=carrier_link&ref=c_12');
});

// Scenario 2: Generation of Telegram Bot Deep Link with Referral Token
runTest('Generation of Telegram Bot Deep Link with referral token', () => {
    const links = generateTripLinks(45, 12);
    assert.strictEqual(links.bot, 'https://t.me/Poputkionline_bot?start=bus_45_c12');
});

// Scenario 3: Telegram Bot Start Param Parser with Referral Token
runTest('Bot start_param parser correctly splits ticket ID and referral token', () => {
    const res = parseBotStartParam('bus_45_c12');
    assert.strictEqual(res.busId, '45');
    assert.strictEqual(res.refToken, 'c12');
});

// Scenario 4: Backward Compatibility - Telegram Bot Start Param without Referral Token
runTest('Bot start_param parser backward compatibility for bare bus_45', () => {
    const res = parseBotStartParam('bus_45');
    assert.strictEqual(res.busId, '45');
    assert.strictEqual(res.refToken, null);
});

// Scenario 5: Router Start Param Handler captures Telegram Attribution to sessionStorage
runTest('Router start_param handler extracts attribution and sets sessionStorage', () => {
    const res = simulateRouterParamHandling('bus_45_c12');
    assert.strictEqual(res.route, '/bus-ticket/45');
    assert.strictEqual(res.attribution.channel, 'telegram');
    assert.strictEqual(res.attribution.source_type, 'carrier_link');
    assert.strictEqual(res.attribution.source_id, '12');
    assert.strictEqual(res.sessionStorage['booking_attribution_45'], JSON.stringify(res.attribution));
});

// Scenario 6: BusTicketDetailsView Web Query Param Capture
runTest('Details view captures web carrier referral link', () => {
    const res = simulateDetailsViewCapture(45, { source: 'carrier_link', ref: 'c_12', channel: 'web' });
    assert.strictEqual(res.attribution.channel, 'web');
    assert.strictEqual(res.attribution.source_type, 'carrier_link');
    assert.strictEqual(res.attribution.source_id, '12');
    assert.strictEqual(res.sessionStorage['booking_attribution_45'], JSON.stringify(res.attribution));
});

// Scenario 7: BusTicketDetailsView Direct Opening Default Attribution
runTest('Details view default attribution on direct opening without query params', () => {
    const res = simulateDetailsViewCapture(45, {});
    assert.strictEqual(res.attribution.channel, 'web');
    assert.strictEqual(res.attribution.source_type, 'direct');
    assert.strictEqual(res.attribution.source_id, null);
});

// Scenario 8: Backend Invoice Creation with Valid Carrier Attribution
runTest('Backend accepts valid carrier_link attribution matching ticket operator', () => {
    const ticket = { id: 45, operator_id: 12 };
    const input = { channel: 'web', source_type: 'carrier_link', source_id: '12' };
    const result = validateAndSanitizeBookingAttribution(input, ticket);
    assert.strictEqual(result.channel, 'web');
    assert.strictEqual(result.source_type, 'carrier_link');
    assert.strictEqual(result.source_id, '12');
    assert.strictEqual(result.created_by_user_id, null);
});

// Scenario 9: Backend Anti-Spoofing - Cross Carrier Referral Rejected and Sanitized
runTest('Backend rejects and sanitizes spoofed carrier attribution from different carrier', () => {
    const ticket = { id: 45, operator_id: 12 }; // Ticket belongs to carrier 12
    const maliciousInput = { channel: 'web', source_type: 'carrier_link', source_id: '99' }; // Carrier 99 trying to claim credit
    const result = validateAndSanitizeBookingAttribution(maliciousInput, ticket);
    assert.strictEqual(result.channel, 'web');
    assert.strictEqual(result.source_type, 'direct', 'Spoofed carrier_link must be downgraded to direct');
    assert.strictEqual(result.source_id, null, 'Spoofed source_id must be purged');
    assert.strictEqual(result.created_by_user_id, null);
});

// Scenario 10: Backend Input Sanitization for Invalid Channel/Source
runTest('Backend sanitizes invalid channel and source_type values', () => {
    const ticket = { id: 45, operator_id: 12 };
    const invalidInput = { channel: 'INVALID_HACK', source_type: 'SQL_INJECTION', source_id: 'bad' };
    const result = validateAndSanitizeBookingAttribution(invalidInput, ticket);
    assert.strictEqual(result.channel, 'web');
    assert.strictEqual(result.source_type, 'direct');
    assert.strictEqual(result.source_id, 'bad');
});

// Scenario 11: Backend Manual Booking Attribution Enforcement
runTest('Backend manual booking forces attribution to verified req.carrier identity', () => {
    const reqCarrier = { carrier_id: 12, user_id: 50 };
    const spoofedClientInput = { channel: 'web', source_type: 'platform', source_id: '999', created_by_user_id: 1 };
    const result = createManualBookingAttribution(reqCarrier, spoofedClientInput);
    assert.strictEqual(result.channel, 'manual');
    assert.strictEqual(result.source_type, 'manual');
    assert.strictEqual(result.source_id, '12');
    assert.strictEqual(result.created_by_user_id, 50);
});

// Scenario 12: Backward Compatibility - Missing Attribution Payload in /create-invoice
runTest('Backend gracefully handles legacy/missing attribution payload', () => {
    const ticket = { id: 45, operator_id: 12 };
    const legacyEmptyInput = {};
    const result = validateAndSanitizeBookingAttribution(legacyEmptyInput, ticket);
    assert.strictEqual(result.channel, 'web');
    assert.strictEqual(result.source_type, 'direct');
    assert.strictEqual(result.source_id, null);
    assert.strictEqual(result.created_by_user_id, null);
});

console.log(`\n========================================`);
console.log(`Phase 1 Test Results: ${passedTests}/${totalTests} Passed`);
console.log(`========================================\n`);

if (passedTests === totalTests) {
    console.log('ALL 12 PHASE 1 TEST SCENARIOS PASSED SUCCESSFULLY!\n');
} else {
    process.exit(1);
}
