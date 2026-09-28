/**
 * tests/phase_changed_fields_normalization_unit.test.js
 *
 * Pure unit tests for utils/changedFieldsNormalization.js — the extracted,
 * side-effect-free normalization helpers routes/busAdmin.js now uses to
 * compute changed_fields (see phase_notification_recipient_fix_and_
 * changed_fields_normalization.test.js for the same behavior proven through
 * the real HTTP route).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeTimeOfDay,
    normalizeNullableText,
    computeChangedFields
} = require('../utils/changedFieldsNormalization');

describe('normalizeTimeOfDay', () => {
    it('treats "HH:MM:SS" and "HH:MM" for the same instant as equal', () => {
        assert.equal(normalizeTimeOfDay('06:35:00'), normalizeTimeOfDay('06:35'));
    });

    it('pads single-digit hours consistently', () => {
        assert.equal(normalizeTimeOfDay('6:35'), '06:35');
        assert.equal(normalizeTimeOfDay('06:35:00'), '06:35');
    });

    it('null, undefined, and "" all normalize to null', () => {
        assert.equal(normalizeTimeOfDay(null), null);
        assert.equal(normalizeTimeOfDay(undefined), null);
        assert.equal(normalizeTimeOfDay(''), null);
    });

    it('a genuinely different time is still detected as different', () => {
        assert.notEqual(normalizeTimeOfDay('06:35:00'), normalizeTimeOfDay('07:35:00'));
    });
});

describe('normalizeNullableText', () => {
    it('null, undefined, "", and whitespace-only are all equivalent-empty', () => {
        const values = [null, undefined, '', '   ', '\t\n'];
        const normalized = values.map(normalizeNullableText);
        assert.ok(normalized.every(v => v === ''));
    });

    it('a non-empty value survives, trimmed', () => {
        assert.equal(normalizeNullableText('  Иванов Иван  '), 'Иванов Иван');
    });

    it('two different non-empty values are still detected as different', () => {
        assert.notEqual(normalizeNullableText('Иванов'), normalizeNullableText('Петров'));
    });
});

describe('computeChangedFields', () => {
    it('a format-only time difference produces no changed field', () => {
        const oldTicket = { arrival_time: '06:35:00' };
        const { changedFields } = computeChangedFields(oldTicket, { arrival_time: '06:35' });
        assert.deepEqual(changedFields, []);
    });

    it('a real time difference is reported', () => {
        const oldTicket = { departure_time: '10:00:00' };
        const { changedFields } = computeChangedFields(oldTicket, { departure_time: '12:30' });
        assert.deepEqual(changedFields, ['departure_time']);
    });

    it('null vs empty string for a nullable text field produces no changed field', () => {
        const oldTicket = { group_leader_name: null, group_leader_phone: '', passenger_comments: null };
        const { changedFields } = computeChangedFields(oldTicket, {
            group_leader_name: '',
            group_leader_phone: '   ',
            passenger_comments: undefined === undefined ? '' : '' // explicit empty, not omitted
        });
        assert.deepEqual(changedFields, []);
    });

    it('a real non-empty text change is reported', () => {
        const oldTicket = { group_leader_whatsapp: null };
        const { changedFields } = computeChangedFields(oldTicket, { group_leader_whatsapp: '+992900000000' });
        assert.deepEqual(changedFields, ['group_leader_whatsapp']);
    });

    it('fields outside the time/nullable-text sets keep raw JSON.stringify comparison semantics', () => {
        const oldTicket = { price: 840, bus_id: null, photos: [{ url: 'a', public_id: 'a' }] };
        const { changedFields: c1 } = computeChangedFields(oldTicket, { price: 840 });
        assert.deepEqual(c1, [], 'identical price must not be a changed field');

        const { changedFields: c2 } = computeChangedFields(oldTicket, { price: 900 });
        assert.deepEqual(c2, ['price']);

        const { changedFields: c3 } = computeChangedFields(oldTicket, { photos: [{ url: 'a', public_id: 'a' }] });
        assert.deepEqual(c3, [], 'structurally identical arrays must not be a changed field');
    });

    it('oldValues/newValues only include actually-changed fields, using the RAW (non-normalized) values', () => {
        const oldTicket = { arrival_time: '06:35:00', price: 840 };
        const { oldValues, newValues, changedFields } = computeChangedFields(oldTicket, { arrival_time: '06:35', price: 900 });
        assert.deepEqual(changedFields, ['price']);
        assert.deepEqual(oldValues, { price: 840 });
        assert.deepEqual(newValues, { price: 900 });
    });
});
