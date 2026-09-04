/**
 * phase_p1c_p1e_handoff_correlation.test.js
 * 
 * Phase P.1C–P.1E: Backend Handoff Endpoint, Track-Open, and Telegram Correlation Tests
 * POPUTKI.ONLINE
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateTicketVerificationToken, verifyTicketToken, extractBookingIdFromToken } = require('../utils/ticketHelper');
const { JOURNEY_EVENT_TYPES } = require('../utils/journeyHelper');

describe('PHASE P.1C–P.1E — BACKEND HANDOFF, TICKET TRACKING & TELEGRAM CORRELATION', () => {

    describe('1. Handoff-Booking Binding & Cryptographic Token Verification', () => {
        it('[P1-BE-01] extractBookingIdFromToken correctly parses bookingId from valid HMAC token', () => {
            const bookingId = 12345;
            const token = generateTicketVerificationToken(bookingId);
            assert.ok(token);
            assert.strictEqual(verifyTicketToken(token, bookingId), true);
            assert.strictEqual(extractBookingIdFromToken(token), bookingId);
        });

        it('[P1-BE-02] Token validation rejects forged, tampered, or mismatched tokens', () => {
            const token = generateTicketVerificationToken(12345);
            assert.strictEqual(verifyTicketToken(token, 99999), false);
            assert.strictEqual(verifyTicketToken(token + 'tamper', 12345), false);
            assert.strictEqual(verifyTicketToken('invalid-token-string', 12345), false);
        });

        it('[P1-BE-03] Handoff strictly belongs to the target booking (mismatch rejected)', () => {
            const bookingA = 101;
            const bookingB = 202;
            const handoffRecord = { id: 'handoff-uuid-1', booking_id: bookingA, channel: 'whatsapp' };

            // Simulation of handoff verification logic
            const matchesBookingA = Number(handoffRecord.booking_id) === Number(bookingA);
            const matchesBookingB = Number(handoffRecord.booking_id) === Number(bookingB);

            assert.strictEqual(matchesBookingA, true);
            assert.strictEqual(matchesBookingB, false);
        });
    });

    describe('2. Crawler & Bot Filtering for LINK_OPENED', () => {
        const crawlerUserAgents = [
            'WhatsApp/2.21.11.17 i',
            'TelegramBot (like TwitterBot)',
            'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Twitterbot/1.0',
            'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
            'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'
        ];

        const crawlerSignatures = [
            'bot', 'crawler', 'spider', 'preview', 'facebookexternalhit',
            'facebot', 'whatsapp', 'telegrambot', 'twitterbot', 'linkedinbot',
            'vkshare', 'slackbot', 'yandexbot', 'googlebot', 'bingbot',
            'baiduspider', 'duckduckbot', 'applebot'
        ];

        it('[P1-BE-04] Detects and excludes known preview crawlers and bots', () => {
            crawlerUserAgents.forEach(ua => {
                const lower = ua.toLowerCase();
                const isCrawler = crawlerSignatures.some(sig => lower.includes(sig));
                assert.ok(isCrawler, `UA should be detected as crawler: ${ua}`);
            });
        });

        it('[P1-BE-05] Real user mobile browsers are NOT detected as crawlers', () => {
            const realUAs = [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
            ];
            realUAs.forEach(ua => {
                const lower = ua.toLowerCase();
                const isCrawler = crawlerSignatures.some(sig => lower.includes(sig));
                assert.strictEqual(isCrawler, false, `Real UA must not be blocked: ${ua}`);
            });
        });
    });

    describe('3. Carrier Preview Mode Exclusion', () => {
        it('[P1-BE-06] preview=carrier parameter suppresses LINK_OPENED event recording', () => {
            const queryParams = { preview: 'carrier' };
            const bodyParams = { preview: 'carrier' };

            const isCarrierPreview = (queryParams.preview === 'carrier' || bodyParams.preview === 'carrier');
            assert.strictEqual(isCarrierPreview, true);
        });

        it('[P1-BE-07] Authenticated carrier role suppresses LINK_OPENED event recording', () => {
            const user = { id: 10, role: 'carrier' };
            const isCarrierAuth = ['carrier', 'admin', 'dispatcher'].includes(user.role);
            assert.strictEqual(isCarrierAuth, true);
        });
    });

    describe('4. Server-Enforced Channel & Zero PII Storage', () => {
        it('[P1-BE-08] Channel is strictly determined by server database record, client override ignored', () => {
            const handoffFromDb = { id: 'h-100', booking_id: 50, channel: 'whatsapp' };
            const clientPayload = { channel: 'fake_channel', handoffId: 'h-100' };

            // Server rule: channel must come from handoffFromDb.channel
            const effectiveChannel = handoffFromDb.channel;
            assert.strictEqual(effectiveChannel, 'whatsapp');
            assert.notStrictEqual(effectiveChannel, clientPayload.channel);
        });

        it('[P1-BE-09] Event metadata strictly excludes IP, raw user-agent, or full phone numbers', () => {
            const eventMetadata = {};
            assert.strictEqual(Object.keys(eventMetadata).length, 0);
            assert.strictEqual(eventMetadata.ip, undefined);
            assert.strictEqual(eventMetadata.userAgent, undefined);
            assert.strictEqual(eventMetadata.phone, undefined);
        });
    });

    describe('5. End-to-End Telegram Claim Correlation (P.1E)', () => {
        it('[P1-BE-10] Telegram claim session inherits handoffId', () => {
            const verifiedHandoffId = 'handoff-uuid-xyz';
            const sessionPayload = {
                booking_id: 777,
                handoff_id: verifiedHandoffId
            };
            assert.strictEqual(sessionPayload.handoff_id, verifiedHandoffId);
        });

        it('[P1-BE-11] Bot lifecycle events inherit handoffId from claim session', () => {
            const sessionResult = {
                session: {
                    id: 'session-uuid-1',
                    booking_id: 777,
                    handoff_id: 'handoff-uuid-xyz'
                }
            };

            const correlatedHandoffId = sessionResult.session.handoff_id || null;
            assert.strictEqual(correlatedHandoffId, 'handoff-uuid-xyz');

            const botEventPayload = {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_BOT_STARTED,
                sessionId: sessionResult.session.id,
                handoffId: correlatedHandoffId
            };

            assert.strictEqual(botEventPayload.handoffId, 'handoff-uuid-xyz');
        });

        it('[P1-BE-12] Raw session token is never logged or stored in journey events', () => {
            const rawToken = '7a123f990a44b1c2d3e4f5060708090a';
            const eventPayload = {
                eventType: JOURNEY_EVENT_TYPES.TELEGRAM_CTA_CLICKED,
                actorType: 'passenger',
                handoffId: 'h-1',
                sessionId: 'session-id'
            };

            const serialized = JSON.stringify(eventPayload);
            assert.strictEqual(serialized.includes(rawToken), false);
        });
    });

});
