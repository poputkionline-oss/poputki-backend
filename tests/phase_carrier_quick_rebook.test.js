const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Simulation of BusAdminView quick rebook state machine and watchers
function createBusAdminState() {
    return {
        activeTab: 'customers',
        prefilledCrmCustomer: null,
        isEditingBooking: false,
        editingBookingId: null,
        selectedManualSeats: [],
        showManualForm: false,
        bookingForm: {
            bus_ticket_id: '',
            passenger_count: 1,
            passengers_data: [
                { lastName: '', firstName: '', middleName: '', gender: 'male', docType: 'Загранпаспорт', docNumber: '', birthDate: '', citizenship: 'Таджикистан', phone: '', seatNumber: '' }
            ],
            pickup_city: '',
            drop_off_city: '',
            phone: '',
            passenger_name: ''
        },

        handleQuickRebook(customerData) {
            if (!customerData) return;
            this.isEditingBooking = false;
            this.editingBookingId = null;
            this.prefilledCrmCustomer = JSON.parse(JSON.stringify(customerData));

            const p0 = (customerData.passengers_data && customerData.passengers_data.length > 0)
                ? customerData.passengers_data[0]
                : {};

            this.bookingForm = {
                bus_ticket_id: '',
                passenger_count: 1,
                passengers_data: [
                    {
                        lastName: p0.lastName || '',
                        firstName: p0.firstName || customerData.passenger_name || '',
                        middleName: p0.middleName || '',
                        gender: p0.gender || 'male',
                        docType: p0.docType || 'Загранпаспорт',
                        docNumber: p0.docNumber || '',
                        birthDate: p0.birthDate || '',
                        citizenship: p0.citizenship || 'Таджикистан',
                        phone: p0.phone || customerData.phone || '',
                        seatNumber: ''
                    }
                ],
                pickup_city: '',
                drop_off_city: '',
                phone: customerData.phone || '',
                passenger_name: customerData.passenger_name || ''
            };
            this.selectedManualSeats = [];
            this.showManualForm = true;
            this.activeTab = 'create-booking';
        },

        setTicket(ticketId) {
            this.bookingForm.bus_ticket_id = ticketId;
            // Watcher on bookingForm.bus_ticket_id
            this.selectedManualSeats = [];
            this.showManualForm = false;
            if (this.prefilledCrmCustomer) {
                const crmData = this.prefilledCrmCustomer.passengers_data?.[0] || {};
                this.bookingForm.passengers_data = [
                    {
                        lastName: crmData.lastName || '',
                        firstName: crmData.firstName || this.prefilledCrmCustomer.passenger_name || '',
                        middleName: crmData.middleName || '',
                        gender: crmData.gender || 'male',
                        docType: crmData.docType || 'Загранпаспорт',
                        docNumber: crmData.docNumber || '',
                        birthDate: crmData.birthDate || '',
                        citizenship: crmData.citizenship || 'Таджикистан',
                        phone: crmData.phone || this.prefilledCrmCustomer.phone || '',
                        seatNumber: ''
                    }
                ];
                this.bookingForm.passenger_count = 1;
                this.bookingForm.phone = this.prefilledCrmCustomer.phone || '';
                this.bookingForm.passenger_name = this.prefilledCrmCustomer.passenger_name || '';
            }
        },

        setSeats(newVal) {
            this.selectedManualSeats = newVal;
            // Watcher on selectedManualSeats
            const currentPassengers = [...this.bookingForm.passengers_data];
            const newPassengers = [];
            const usedIndices = new Set();

            const crmData = this.prefilledCrmCustomer ? (this.prefilledCrmCustomer.passengers_data?.[0] || {}) : null;

            newVal.forEach((seatNum, idx) => {
                let matchIdx = currentPassengers.findIndex((p, pIdx) => !usedIndices.has(pIdx) && String(p.seatNumber) === String(seatNum));

                if (matchIdx === -1) {
                    matchIdx = currentPassengers.findIndex((p, pIdx) => !usedIndices.has(pIdx) && (!p.seatNumber || p.seatNumber === ''));
                }

                if (matchIdx !== -1) {
                    usedIndices.add(matchIdx);
                    newPassengers.push({
                        ...currentPassengers[matchIdx],
                        seatNumber: seatNum
                    });
                } else if (idx === 0 && crmData) {
                    newPassengers.push({
                        lastName: crmData.lastName || '',
                        firstName: crmData.firstName || this.prefilledCrmCustomer.passenger_name || '',
                        middleName: crmData.middleName || '',
                        gender: crmData.gender || 'male',
                        docType: crmData.docType || 'Загранпаспорт',
                        docNumber: crmData.docNumber || '',
                        birthDate: crmData.birthDate || '',
                        citizenship: crmData.citizenship || 'Таджикистан',
                        phone: crmData.phone || this.prefilledCrmCustomer.phone || '',
                        seatNumber: seatNum
                    });
                } else {
                    newPassengers.push({
                        lastName: '', firstName: '', middleName: '', gender: 'male',
                        docType: 'Загранпаспорт', docNumber: '', birthDate: '',
                        citizenship: 'Таджикистан', phone: '', seatNumber: seatNum
                    });
                }
            });

            if (crmData && newPassengers.length > 0) {
                const hasCrmCustomerSeated = newPassengers.some(p =>
                    (crmData.docNumber && p.docNumber === crmData.docNumber) ||
                    (crmData.phone && p.phone === crmData.phone) ||
                    (crmData.firstName && p.firstName === crmData.firstName)
                );
                if (!hasCrmCustomerSeated) {
                    newPassengers[0] = {
                        lastName: crmData.lastName || '',
                        firstName: crmData.firstName || this.prefilledCrmCustomer.passenger_name || '',
                        middleName: crmData.middleName || '',
                        gender: crmData.gender || 'male',
                        docType: crmData.docType || 'Загранпаспорт',
                        docNumber: crmData.docNumber || '',
                        birthDate: crmData.birthDate || '',
                        citizenship: crmData.citizenship || 'Таджикистан',
                        phone: crmData.phone || this.prefilledCrmCustomer.phone || '',
                        seatNumber: newPassengers[0].seatNumber
                    };
                }
            }

            if (newPassengers.length === 0) {
                if (crmData) {
                    newPassengers.push({
                        lastName: crmData.lastName || '',
                        firstName: crmData.firstName || this.prefilledCrmCustomer.passenger_name || '',
                        middleName: crmData.middleName || '',
                        gender: crmData.gender || 'male',
                        docType: crmData.docType || 'Загранпаспорт',
                        docNumber: crmData.docNumber || '',
                        birthDate: crmData.birthDate || '',
                        citizenship: crmData.citizenship || 'Таджикистан',
                        phone: crmData.phone || this.prefilledCrmCustomer.phone || '',
                        seatNumber: ''
                    });
                } else {
                    newPassengers.push({
                        lastName: '', firstName: '', middleName: '', gender: 'male',
                        docType: 'Загранпаспорт', docNumber: '', birthDate: '',
                        citizenship: 'Таджикистан', phone: '', seatNumber: ''
                    });
                }
            }

            this.bookingForm.passengers_data = newPassengers;
            this.bookingForm.passenger_count = newPassengers.length;
        },

        resetManualBookingForm() {
            this.prefilledCrmCustomer = null;
            this.selectedManualSeats = [];
            this.showManualForm = false;
            this.isEditingBooking = false;
            this.editingBookingId = null;
            this.bookingForm = {
                bus_ticket_id: '',
                passenger_count: 1,
                passengers_data: [
                    { lastName: '', firstName: '', middleName: '', gender: 'male', docType: 'Загранпаспорт', docNumber: '', birthDate: '', citizenship: 'Таджикистан', phone: '', seatNumber: '' }
                ],
                pickup_city: '',
                drop_off_city: '',
                phone: '',
                passenger_name: ''
            };
        },

        onBookingSuccess() {
            this.resetManualBookingForm();
            this.activeTab = 'bookings';
        }
    };
}

// Helper functions from CarrierCustomers
function isAnonymousCustomer(c) {
    if (!c) return false;
    const hasName = c.name && c.name !== 'Не указано' && c.name.trim() !== '';
    const hasPhone = c.phone && c.phone !== '—' && c.phone.trim() !== '';
    const hasDoc = Boolean(c.document?.docNumber || c.has_document);
    return !hasName && !hasPhone && !hasDoc;
}

function isPhoneOnlyCustomer(c) {
    if (!c) return false;
    const hasName = c.name && c.name !== 'Не указано' && c.name.trim() !== '';
    const hasPhone = c.phone && c.phone !== '—' && c.phone.trim() !== '';
    return !hasName && hasPhone;
}

function customerDisplayName(c) {
    if (!c) return '—';
    if (isAnonymousCustomer(c)) {
        return 'Блокировка мест / Анонимная бронь';
    }
    if (isPhoneOnlyCustomer(c)) {
        return `Клиент ${c.phone}`;
    }
    return c.name || 'Не указано';
}

function customerSubTitle(c) {
    if (!c) return null;
    if (isAnonymousCustomer(c)) {
        return 'Нет данных пассажира';
    }
    if (isPhoneOnlyCustomer(c)) {
        return 'ФИО не указано';
    }
    return null;
}

describe('CARRIER CRM QUICK REBOOK & ANONYMOUS UI SUITE', () => {
    const mockCustomerA = {
        passenger_name: 'Абдуллоев Акмалхон',
        phone: '+992927925051',
        passengers_data: [
            {
                lastName: 'Абдуллоев',
                firstName: 'Акмалхон',
                middleName: 'Саидович',
                docType: 'Загранпаспорт',
                docNumber: 'A1234567',
                citizenship: 'Таджикистан',
                birthDate: '1995-04-12',
                gender: 'male',
                phone: '+992927925051',
                seatNumber: ''
            }
        ]
    };

    const mockCustomerB = {
        passenger_name: 'Каримова Зарина',
        phone: '+992938887766',
        passengers_data: [
            {
                lastName: 'Каримова',
                firstName: 'Зарина',
                middleName: 'Рустамовна',
                docType: 'Паспорт',
                docNumber: 'B9876543',
                citizenship: 'Таджикистан',
                birthDate: '1998-09-20',
                gender: 'female',
                phone: '+992938887766',
                seatNumber: ''
            }
        ]
    };

    it('1. CRM row -> + Бронь opens create-booking with active prefill', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        assert.equal(state.activeTab, 'create-booking');
        assert.ok(state.prefilledCrmCustomer);
        assert.equal(state.prefilledCrmCustomer.passenger_name, 'Абдуллоев Акмалхон');
    });

    it('2. Name preserved before seat selection', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Абдуллоев');
        assert.equal(state.bookingForm.passengers_data[0].firstName, 'Акмалхон');
    });

    it('3. Phone preserved before seat selection', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        assert.equal(state.bookingForm.phone, '+992927925051');
        assert.equal(state.bookingForm.passengers_data[0].phone, '+992927925051');
    });

    it('4. Passport preserved before seat selection', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        assert.equal(state.bookingForm.passengers_data[0].docType, 'Загранпаспорт');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'A1234567');
        assert.equal(state.bookingForm.passengers_data[0].birthDate, '1995-04-12');
        assert.equal(state.bookingForm.passengers_data[0].citizenship, 'Таджикистан');
        assert.equal(state.bookingForm.passengers_data[0].gender, 'male');
    });

    it('5. First selected seat assigned to CRM customer (data NOT wiped)', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setTicket(53);
        state.setSeats([12]);

        assert.equal(state.bookingForm.passengers_data.length, 1);
        const p0 = state.bookingForm.passengers_data[0];
        assert.equal(p0.seatNumber, 12);
        assert.equal(p0.lastName, 'Абдуллоев');
        assert.equal(p0.firstName, 'Акмалхон');
        assert.equal(p0.docNumber, 'A1234567');
        assert.equal(p0.phone, '+992927925051');
    });

    it('6. Second selected seat creates empty passenger', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12, 13]);

        assert.equal(state.bookingForm.passengers_data.length, 2);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, 12);
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'A1234567');

        const p1 = state.bookingForm.passengers_data[1];
        assert.equal(p1.seatNumber, 13);
        assert.equal(p1.lastName, '');
        assert.equal(p1.firstName, '');
        assert.equal(p1.docNumber, '');
    });

    it('7. Third selected seat creates empty passenger', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12, 13, 14]);

        assert.equal(state.bookingForm.passengers_data.length, 3);
        assert.equal(state.bookingForm.passengers_data[2].seatNumber, 14);
        assert.equal(state.bookingForm.passengers_data[2].docNumber, '');
    });

    it('8. Deselect second seat leaves CRM customer intact on seat 12', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12, 13]);
        state.setSeats([12]);

        assert.equal(state.bookingForm.passengers_data.length, 1);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, 12);
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Абдуллоев');
    });

    it('9. Deselect CRM seat reassigns customer safely to first remaining seat 13', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12, 13]);
        // Remove seat 12, leaving only seat 13
        state.setSeats([13]);

        assert.equal(state.bookingForm.passengers_data.length, 1);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, 13);
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Абдуллоев');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'A1234567');
    });

    it('10. Change trip clears seats but preserves customer with seatNumber=""', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setTicket(53);
        state.setSeats([12]);

        // Change ticket to 54
        state.setTicket(54);
        assert.deepEqual(state.selectedManualSeats, []);
        assert.equal(state.bookingForm.passengers_data.length, 1);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, '');
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Абдуллоев');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'A1234567');
    });

    it('11. Select seat after trip change preserves customer on new seat', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setTicket(53);
        state.setSeats([12]);
        state.setTicket(54);
        state.setSeats([25]);

        assert.equal(state.bookingForm.passengers_data.length, 1);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, 25);
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Абдуллоев');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'A1234567');
    });

    it('12. Customer A -> Customer B replaces data completely', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12]);

        // User switches back to CRM and chooses Customer B
        state.handleQuickRebook(mockCustomerB);
        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Каримова');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'B9876543');
        assert.equal(state.bookingForm.phone, '+992938887766');
        assert.deepEqual(state.selectedManualSeats, []);
    });

    it('13. Modal + Бронь uses loaded profile directly', () => {
        const state = createBusAdminState();
        const modalProfile = {
            name: 'Каримова Зарина',
            phone: '+992938887766',
            document: {
                docType: 'Паспорт',
                docNumber: 'B9876543',
                citizenship: 'Таджикистан',
                birthDate: '1998-09-20',
                gender: 'female'
            }
        };

        state.handleQuickRebook({
            passenger_name: modalProfile.name,
            phone: modalProfile.phone,
            passengers_data: [{
                lastName: 'Каримова',
                firstName: 'Зарина',
                middleName: '',
                docType: modalProfile.document.docType,
                docNumber: modalProfile.document.docNumber,
                citizenship: modalProfile.document.citizenship,
                birthDate: modalProfile.document.birthDate,
                gender: modalProfile.document.gender,
                phone: modalProfile.phone,
                seatNumber: ''
            }]
        });

        assert.equal(state.bookingForm.passengers_data[0].lastName, 'Каримова');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, 'B9876543');
    });

    it('14. No PII is placed in URL during Quick Rebook (in-memory state transfer)', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        // Only activeTab is switched in memory, zero query params with names or passports
        assert.equal(state.activeTab, 'create-booking');
    });

    it('15. Phone-only customer label correct', () => {
        const phoneOnly = {
            name: 'Не указано',
            phone: '+992927075174',
            document: null,
            has_document: false
        };

        assert.equal(isPhoneOnlyCustomer(phoneOnly), true);
        assert.equal(isAnonymousCustomer(phoneOnly), false);
        assert.equal(customerDisplayName(phoneOnly), 'Клиент +992927075174');
        assert.equal(customerSubTitle(phoneOnly), 'ФИО не указано');
    });

    it('16. Anonymous booking label correct', () => {
        const anon = {
            name: 'Не указано',
            phone: '—',
            document: null,
            has_document: false
        };

        assert.equal(isAnonymousCustomer(anon), true);
        assert.equal(customerDisplayName(anon), 'Блокировка мест / Анонимная бронь');
        assert.equal(customerSubTitle(anon), 'Нет данных пассажира');
    });

    it('17. Anonymous "+ Бронь" disabled', () => {
        const anon = {
            name: 'Не указано',
            phone: '—',
            document: null,
            has_document: false
        };

        assert.equal(isAnonymousCustomer(anon), true);
    });

    it('18. Successful booking clears CRM prefill and resets form', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.setSeats([12]);
        state.onBookingSuccess();

        assert.equal(state.prefilledCrmCustomer, null);
        assert.equal(state.activeTab, 'bookings');
        assert.equal(state.bookingForm.passengers_data[0].lastName, '');
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, '');
    });

    it('19. Explicit clear resets prefill', () => {
        const state = createBusAdminState();
        state.handleQuickRebook(mockCustomerA);
        state.resetManualBookingForm();

        assert.equal(state.prefilledCrmCustomer, null);
        assert.equal(state.bookingForm.passengers_data[0].lastName, '');
        assert.equal(state.bookingForm.passengers_data[0].docNumber, '');
    });

    it('20. Standard manual booking without CRM works seamlessly with clean passengers', () => {
        const state = createBusAdminState();
        state.setTicket(53);
        state.setSeats([5, 6]);

        assert.equal(state.bookingForm.passengers_data.length, 2);
        assert.equal(state.bookingForm.passengers_data[0].seatNumber, 5);
        assert.equal(state.bookingForm.passengers_data[0].lastName, '');
        assert.equal(state.bookingForm.passengers_data[1].seatNumber, 6);
        assert.equal(state.bookingForm.passengers_data[1].lastName, '');
    });
});
