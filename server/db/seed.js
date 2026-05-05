'use strict';

/**
 * Database Seed — Idempotent PostgreSQL seeding
 * Phase 1 P0: Seeds real Postgres tables using UPSERT patterns (safe to re-run).
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('./index');

const AIRLINES = [
  { iata_code: 'AI', name: 'Air India',  logo: '✈️' },
  { iata_code: '6E', name: 'IndiGo',     logo: '🛫' },
  { iata_code: 'SG', name: 'SpiceJet',   logo: '🌶️' },
  { iata_code: 'UK', name: 'Vistara',    logo: '💜' },
  { iata_code: 'G8', name: 'Go First',   logo: '🟠' },
];

const AIRPORTS = [
  { iata_code: 'DEL', name: 'Indira Gandhi International',  city: 'New Delhi',  country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'BOM', name: 'Chhatrapati Shivaji Maharaj',  city: 'Mumbai',     country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'BLR', name: 'Kempegowda International',     city: 'Bengaluru',  country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'HYD', name: 'Rajiv Gandhi International',   city: 'Hyderabad',  country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'MAA', name: 'Chennai International',        city: 'Chennai',    country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'CCU', name: 'Netaji Subhas Chandra Bose',   city: 'Kolkata',    country: 'India',     country_code: 'IN', international: true  },
  { iata_code: 'GOI', name: 'Goa International',            city: 'Goa',        country: 'India',     country_code: 'IN', international: false },
  { iata_code: 'LKO', name: 'Chaudhary Charan Singh',       city: 'Lucknow',    country: 'India',     country_code: 'IN', international: false },
  { iata_code: 'DXB', name: 'Dubai International',          city: 'Dubai',      country: 'UAE',       country_code: 'AE', international: true  },
  { iata_code: 'LHR', name: 'Heathrow Airport',             city: 'London',     country: 'UK',        country_code: 'GB', international: true  },
  { iata_code: 'SIN', name: 'Changi Airport',               city: 'Singapore',  country: 'Singapore', country_code: 'SG', international: true  },
  { iata_code: 'BKK', name: 'Suvarnabhumi Airport',         city: 'Bangkok',    country: 'Thailand',  country_code: 'TH', international: true  },
  { iata_code: 'JFK', name: "John F. Kennedy Int'l",        city: 'New York',   country: 'USA',       country_code: 'US', international: true  },
  { iata_code: 'CDG', name: 'Charles de Gaulle',            city: 'Paris',      country: 'France',    country_code: 'FR', international: true  },
];

const ROUTES = [
  { o: 'DEL', d: 'BOM', dur: 135, base: 3200 },
  { o: 'DEL', d: 'BLR', dur: 165, base: 3800 },
  { o: 'DEL', d: 'HYD', dur: 150, base: 3500 },
  { o: 'DEL', d: 'MAA', dur: 165, base: 4200 },
  { o: 'BOM', d: 'DEL', dur: 135, base: 3200 },
  { o: 'BOM', d: 'BLR', dur: 90,  base: 2800 },
  { o: 'BLR', d: 'DEL', dur: 165, base: 3800 },
  { o: 'DEL', d: 'DXB', dur: 210, base: 12000 },
  { o: 'BOM', d: 'DXB', dur: 195, base: 11500 },
  { o: 'DEL', d: 'LHR', dur: 525, base: 28000 },
  { o: 'DEL', d: 'SIN', dur: 330, base: 16000 },
  { o: 'BOM', d: 'BKK', dur: 285, base: 13500 },
  { o: 'DEL', d: 'JFK', dur: 870, base: 45000 },
  { o: 'BOM', d: 'CDG', dur: 525, base: 32000 },
  { o: 'DEL', d: 'GOI', dur: 135, base: 4500 },
];

const DEPARTURE_TIMES = ['05:30','07:45','09:15','11:30','14:00','16:30','18:45','20:15','22:00'];

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

function generatePNR() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function seed() {
  console.log('[Seed] Starting PostgreSQL data seeding (idempotent)...');

  await db.withTransaction(async (client) => {

    // ── Tenants ──────────────────────────────────────────────────────────────
    const tenantIds = {};
    for (const a of AIRLINES) {
      const id = uuidv4();
      await client.query(
        `INSERT INTO tenants (tenant_id, iata_code, airline_name, logo_url, base_currency, config)
         VALUES ($1, $2, $3, $4, 'INR', $5)
         ON CONFLICT (iata_code) DO UPDATE SET airline_name = EXCLUDED.airline_name`,
        [id, a.iata_code, a.name, a.logo, JSON.stringify({
          overbookingPct: 7 + Math.random() * 5,
          dynamicPricing: true,
          loyaltyProgram: a.iata_code === 'AI' ? 'Flying Returns' : 'EdgeRewards',
        })]
      );
      // Fetch back the real id (may have been pre-existing)
      const { rows } = await client.query('SELECT tenant_id FROM tenants WHERE iata_code = $1', [a.iata_code]);
      tenantIds[a.iata_code] = rows[0].tenant_id;
    }

    // ── Airports ─────────────────────────────────────────────────────────────
    for (const ap of AIRPORTS) {
      await client.query(
        `INSERT INTO airports (airport_id, iata_code, name, city, country, country_code, international)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (iata_code) DO NOTHING`,
        [uuidv4(), ap.iata_code, ap.name, ap.city, ap.country, ap.country_code, ap.international]
      );
    }

    // ── Users ─────────────────────────────────────────────────────────────────
    const passwordHash = bcrypt.hashSync('admin123', 10);
    const users = [
      {
        email: 'ankit@skyplatform.in', hash: passwordHash,
        first: 'Ankit', last: 'Aman', phone: '+91-9876543210',
        nat: 'IN', tier: 'GOLD', points: 24500, role: 'admin',
        prefs: { cabin: 'ECONOMY', meal: 'VEG', window: true },
      },
      {
        email: 'priya@example.com', hash: bcrypt.hashSync('pass123', 10),
        first: 'Priya', last: 'Sharma', phone: '+91-9812345678',
        nat: 'IN', tier: 'SILVER', points: 8200, role: 'passenger',
        prefs: { cabin: 'BUSINESS', meal: 'VEGAN', window: false },
      },
      {
        email: 'rahul@example.com', hash: bcrypt.hashSync('pass123', 10),
        first: 'Rahul', last: 'Verma', phone: '+91-9934567890',
        nat: 'IN', tier: 'BLUE', points: 1200, role: 'passenger',
        prefs: { cabin: 'ECONOMY', meal: 'NON_VEG', window: true },
      },
    ];
    for (const u of users) {
      await client.query(
        `INSERT INTO users (user_id, email, password_hash, first_name, last_name, phone, nationality, loyalty_tier, loyalty_points, role, preferences)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (email) DO NOTHING`,
        [uuidv4(), u.email, u.hash, u.first, u.last, u.phone, u.nat, u.tier, u.points, u.role, JSON.stringify(u.prefs)]
      );
    }

    // ── Flights & Inventory (14-day window) ──────────────────────────────────
    const tenantCodes = Object.keys(tenantIds);
    const now = new Date();
    let flightCount = 0;

    for (let day = 0; day < 14; day++) {
      for (const route of ROUTES) {
        const iata = tenantCodes[Math.floor(Math.random() * tenantCodes.length)];
        const tenantId = tenantIds[iata];
        const timeStr = DEPARTURE_TIMES[Math.floor(Math.random() * DEPARTURE_TIMES.length)];
        const depDate = new Date(now);
        depDate.setDate(depDate.getDate() + day);
        depDate.setHours(parseInt(timeStr.split(':')[0]), parseInt(timeStr.split(':')[1]), 0, 0);
        const arrDate = addMinutes(depDate, route.dur);
        const flightNum = `${iata}${100 + Math.floor(Math.random() * 900)}`;
        const flightId = uuidv4();

        await client.query(
          `INSERT INTO flights (flight_id, tenant_id, flight_number, aircraft_type,
             origin_iata, dest_iata, departure_time, arrival_time, duration_minutes, stops, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'SCHEDULED')
           ON CONFLICT DO NOTHING`,
          [flightId, tenantId, flightNum,
           route.dur > 300 ? 'Boeing 787' : 'Airbus A320',
           route.o, route.d, depDate, arrDate, route.dur]
        );

        for (const [cabin, seats, ob, fareMulti] of [['ECONOMY', 150, 7, 1], ['BUSINESS', 24, 3, 3.2], ['FIRST', 8, 0, 6.5]]) {
          const allocated = Math.floor(Math.random() * seats * 0.6);
          await client.query(
            `INSERT INTO flight_inventory (inventory_id, flight_id, cabin_class, physical_seats,
               overbooking_pct, actual_capacity, allocated_seats, locked_seats, base_fare, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 0)
             ON CONFLICT (flight_id, cabin_class) DO NOTHING`,
            [uuidv4(), flightId, cabin, seats, ob,
             Math.ceil(seats * (1 + ob / 100)), allocated, route.base * fareMulti]
          );
        }
        flightCount++;
      }
    }

    // ── AB Tests ──────────────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO ab_tests (test_id, name, description, status, variants, traffic_split, metrics)
       VALUES ($1, 'price_sensitivity_v3', 'Testing demand factor multiplier aggressiveness', 'ACTIVE',
               $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [
        uuidv4(),
        JSON.stringify({ control: { demand_factor_scale: 1.0, velocity_scale: 1.0 }, variant_a: { demand_factor_scale: 1.05, velocity_scale: 0.9 }, variant_b: { demand_factor_scale: 1.0, load_threshold: 0.80 } }),
        JSON.stringify({ control: 33, variant_a: 33, variant_b: 34 }),
        JSON.stringify(['conversion_rate', 'revenue_per_search', 'abandonment_rate']),
      ]
    );

    // ── Coupons ───────────────────────────────────────────────────────────────
    const coupons = [
      { code: 'FIRST10', type: 'PERCENT', value: 10, min_fare: 2000, max_discount: 800 },
      { code: 'FLAT500', type: 'FIXED',   value: 500, min_fare: 3000, max_discount: 500 },
      { code: 'GOLD20',  type: 'PERCENT', value: 20, min_fare: 5000, max_discount: 2000 },
      { code: 'WELCOME', type: 'PERCENT', value: 15, min_fare: 1000, max_discount: 1200 },
    ];
    for (const c of coupons) {
      await client.query(
        `INSERT INTO coupons (coupon_id, code, type, value, min_fare, max_discount, usage_limit, usage_count, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, 100, 0, NOW(), NOW() + INTERVAL '90 days')
         ON CONFLICT (code) DO NOTHING`,
        [uuidv4(), c.code, c.type, c.value, c.min_fare, c.max_discount]
      );
    }

    console.log(`[Seed] ✅ ${AIRLINES.length} airlines, ${AIRPORTS.length} airports, ${flightCount} flights`);
    console.log(`[Seed] ✅ ${users.length} users, ${coupons.length} coupons, 1 AB test`);
  });

  console.log('[Seed] Complete — all data persisted to PostgreSQL.');
}

module.exports = { seed, generatePNR };

// Run directly: node server/db/seed.js
if (require.main === module) {
  seed().then(() => process.exit(0)).catch((err) => {
    console.error('[Seed] Fatal:', err.message);
    process.exit(1);
  });
}
