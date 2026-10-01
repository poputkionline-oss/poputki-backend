'use strict';
function validateReviewInput(body) {
    if (!body || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return false;
    return (body.comment === undefined || typeof body.comment === 'string') && (body.comment || '').length <= 2000;
}
function ownsBusBooking(b, userId) {
    if (b.claimed_by_user_id != null) return String(b.claimed_by_user_id) === String(userId);
    return b.channel !== 'manual' && b.source_type !== 'manual' && b.contact_role !== 'carrier_contact' && String(b.passenger_id) === String(userId);
}
function eligibleBusBooking(b, userId) {
    return ownsBusBooking(b,userId) && b.status === 'confirmed' && b.boarding_status === 'boarded' && b.bus_tickets?.status === 'completed' && String(b.bus_tickets.operator_id) !== String(userId);
}
const reviewErrors = {
    INVALID_REVIEW: [400,'Выберите оценку от 1 до 5. Комментарий — не более 2000 символов.'],
    TRIP_NOT_COMPLETED: [400,'Отзыв можно оставить только после завершения рейса.'],
    PASSENGER_NOT_BOARDED: [403,'Для отзыва требуется подтверждённая посадка.'],
    REVIEW_FORBIDDEN: [403,'Вы не можете оставить отзыв о этой поездке.'],
    ALREADY_REVIEWED: [409,'Вы уже оставили отзыв о этой поездке.']
};
module.exports={validateReviewInput,ownsBusBooking,eligibleBusBooking,reviewErrors};
