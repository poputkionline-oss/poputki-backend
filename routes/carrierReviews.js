const router = require('express').Router();
const { reviewCabinetHandler } = require('../utils/reviewCabinetHelper');
// Mounted after carrierAuth in busAdmin: canonical carrier_id, including members.
router.get('/', reviewCabinetHandler(true));
module.exports = router;
