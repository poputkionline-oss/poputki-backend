const { JOURNEY_EVENT_TYPES: E } = require('./journeyHelper');
const STAGE_EVENTS = {
    manual_booking: [],
    handoff_initiated: [E.SHARE_INITIATED, E.LINK_OPENED],
    link_opened: [E.LINK_OPENED],
    telegram_cta: [E.TELEGRAM_CTA_CLICKED],
    bot_started: [E.TELEGRAM_BOT_STARTED],
    phone_shared: [E.PHONE_SHARED],
    phone_verified: [E.PHONE_VERIFIED],
    booking_linked: [E.BOOKING_LINKED_TO_USER],
    activated: [E.ACTIVATION_COMPLETED, E.CLAIM_COMPLETED]
};
function reachedFunnelStage(stage, types) {
    return stage === 'manual_booking' || STAGE_EVENTS[stage]?.some(type => types.has(type)) || false;
}
module.exports = { STAGE_EVENTS, reachedFunnelStage };
