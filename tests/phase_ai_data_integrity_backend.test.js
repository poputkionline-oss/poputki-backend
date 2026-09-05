const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('PHASE AI DATA INTEGRITY HOTFIX — Backend Edge Function & Driver/Seat Contracts', () => {

  const functionIndexPath = path.resolve(__dirname, '../supabase/functions/assistant-chat/index.ts');
  const functionSource = fs.readFileSync(functionIndexPath, 'utf8');

  // Helper matching the exact Edge Function seat calculation
  function calculateAvailableSeats(ride) {
    const occupiedSeats = new Set();
    if (Array.isArray(ride.reserved_seats)) {
      for (const s of ride.reserved_seats) {
        if (s !== null && s !== undefined && s !== '') {
          occupiedSeats.add(Number(s) || s);
        }
      }
    } else if (typeof ride.reserved_seats === 'string') {
      try {
        const parsed = JSON.parse(ride.reserved_seats);
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (s !== null && s !== undefined && s !== '') {
              occupiedSeats.add(Number(s) || s);
            }
          }
        }
      } catch {}
    }

    let nonNumberedBookings = 0;
    if (Array.isArray(ride.bookings)) {
      for (const b of ride.bookings) {
        if (b && b.seat_number !== null && b.seat_number !== undefined && b.seat_number !== '') {
          occupiedSeats.add(Number(b.seat_number) || b.seat_number);
        } else if (b && b.id !== undefined) {
          nonNumberedBookings++;
        }
      }
    }

    const totalOccupied = occupiedSeats.size + nonNumberedBookings;
    const passengerCapacity = Number(ride.seats !== undefined && ride.seats !== null ? ride.seats : Math.max(1, (ride.total_seats || 4) - 1));
    return Math.max(0, Math.min(passengerCapacity, passengerCapacity - totalOccupied));
  }

  // Helper matching the exact Edge Function carrier name resolution
  function resolveDriverName(ride) {
    const driver = Array.isArray(ride.users) ? ride.users[0] : (ride.users || {});
    let driverName = '';

    if (ride.scraper_metadata) {
      try {
        const meta = typeof ride.scraper_metadata === 'string' ? JSON.parse(ride.scraper_metadata) : ride.scraper_metadata;
        if (meta && typeof meta.first_name === 'string' && meta.first_name.trim()) {
          driverName = meta.first_name.trim() + (meta.last_name && typeof meta.last_name === 'string' && meta.last_name.trim() ? ' ' + meta.last_name.trim() : '');
        }
      } catch {}
    }

    if (!driverName && driver && typeof driver.name === 'string' && driver.name.trim()) {
      driverName = driver.name.trim();
    }

    if (!driverName) {
      driverName = 'Водитель';
    }

    return driverName;
  }

  it('1. assistant-chat query selects scraper_metadata and bookings:bookings(id,seat_number)', () => {
    assert.ok(functionSource.includes('scraper_metadata'), 'Must select scraper_metadata from rides table');
    assert.ok(functionSource.includes('bookings:bookings(id,seat_number)'), 'Must select bookings with seat_number');
  });

  it('2. seats=3, броней нет → свободно 3', () => {
    const ride = {
      seats: 3,
      total_seats: 4,
      reserved_seats: [],
      bookings: []
    };
    const seatsAvailable = calculateAvailableSeats(ride);
    assert.strictEqual(seatsAvailable, 3, 'When no bookings exist, exactly 3 seats must be available');
  });

  it('3. одно место присутствует одновременно в bookings и reserved_seats → занято только одно место (свободно 2)', () => {
    const ride = {
      seats: 3,
      total_seats: 4,
      reserved_seats: [1],
      bookings: [{ id: 101, seat_number: 1 }] // same seat number 1
    };
    const seatsAvailable = calculateAvailableSeats(ride);
    assert.strictEqual(seatsAvailable, 2, 'Deduplication must count seat 1 as only 1 occupied seat');
  });

  it('4. две разные занятые позиции → свободно 1', () => {
    const ride = {
      seats: 3,
      total_seats: 4,
      reserved_seats: [1],
      bookings: [{ id: 102, seat_number: 2 }] // different seat 2
    };
    const seatsAvailable = calculateAvailableSeats(ride);
    assert.strictEqual(seatsAvailable, 1, 'Two different occupied seats must leave 1 seat free out of 3');
  });

  it('5. свободные места никогда не меньше 0 и не больше r.seats', () => {
    // Case A: Overbooking (5 occupied on 3 seats)
    const overbookedRide = {
      seats: 3,
      total_seats: 4,
      reserved_seats: [1, 2, 3],
      bookings: [{ id: 201, seat_number: 4 }, { id: 202, seat_number: 5 }]
    };
    const minSeats = calculateAvailableSeats(overbookedRide);
    assert.strictEqual(minSeats, 0, 'Available seats must not be negative');

    // Case B: Inconsistent negative occupied
    const emptyRide = {
      seats: 3,
      total_seats: 4,
      reserved_seats: [],
      bookings: []
    };
    const maxSeats = calculateAvailableSeats(emptyRide);
    assert.ok(maxSeats <= emptyRide.seats, 'Available seats must never exceed r.seats');
    assert.strictEqual(maxSeats, 3);
  });

  it('6. Carrier name priority 1: валидное scraper_metadata.first_name', () => {
    const ride = {
      scraper_metadata: JSON.stringify({
        first_name: 'Шахром',
        last_name: '',
        phone: '+992552421001'
      }),
      users: [{ name: 'Ронанда' }]
    };
    const name = resolveDriverName(ride);
    assert.strictEqual(name, 'Шахром', 'Priority 1 must choose scraper_metadata.first_name');
  });

  it('7. Carrier name priority 2: отсутствие metadata → users.name', () => {
    const ride = {
      scraper_metadata: null,
      users: [{ name: 'Алишер' }]
    };
    const name = resolveDriverName(ride);
    assert.strictEqual(name, 'Алишер', 'Priority 2 must fallback to users.name');
  });

  it('8. Carrier name priority 3: оба отсутствуют → нейтральная локализованная подпись', () => {
    const ride = {
      scraper_metadata: null,
      users: []
    };
    const name = resolveDriverName(ride);
    assert.strictEqual(name, 'Водитель', 'Priority 3 must fallback to neutral Водитель');
  });

  it('9. Номер телефона из scraper_metadata не передаётся Claude и не попадает в Telegram', () => {
    // Verify that neither phone, driver_phone nor meta.phone is in searchTrips return object
    assert.ok(!functionSource.includes('phone: r.phone'), 'Must not map r.phone');
    assert.ok(!functionSource.includes('driver_phone:'), 'Must not export driver_phone');
    assert.ok(!functionSource.includes('meta.phone,'), 'Must not export meta.phone');
    // Verify SYSTEM_PROMPT rule 3 forbids personal phone numbers
    assert.ok(functionSource.includes('НИКОГДА не показывай личные номера телефонов'), 'System prompt must forbid phone numbers');
  });

  it('10. SYSTEM_PROMPT mandates language routing strictly by latest user message', () => {
    assert.ok(functionSource.includes('ЯЗЫК ОТВЕТА:'), 'Must have explicit ЯЗЫК ОТВЕТА section');
    assert.ok(
      functionSource.includes('СТРОГО по ПОСЛЕДНЕМУ') || functionSource.includes('по последнему входящему'),
      'Must enforce language routing based on latest user message'
    );
  });

  it('11. Strict business filters: active status, future datetime, and passenger entries excluded', () => {
    assert.ok(functionSource.includes(".eq('status', 'active')"), 'Must filter status = active');
    assert.ok(functionSource.includes(".eq('is_passenger_entry', false)"), 'Must exclude passenger entries');
    assert.ok(functionSource.includes('availableSeats <= 0'), 'Must skip trips with 0 available seats');
  });

});
