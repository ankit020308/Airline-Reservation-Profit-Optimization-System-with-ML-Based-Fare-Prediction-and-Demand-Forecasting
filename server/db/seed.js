'use strict';

/**
 * Database Seed — Populates in-memory store with realistic data
 * Also runs SQL schema against PostgreSQL if available
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('./index');

const AIRLINES = [
  { iata_code: 'AI', name: 'Air India', logo: '✈️' },
  { iata_code: '6E', name: 'IndiGo', logo: '🛫' },
  { iata_code: 'SG', name: 'SpiceJet', logo: '🌶️' },
  { iata_code: 'UK', name: 'Vistara', logo: '💜' },
  { iata_code: 'G8', name: 'Go First', logo: '🟠' },
];

const AIRPORTS = [
  { iata_code: 'DEL', name: 'Indira Gandhi International', city: 'New Delhi', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'BOM', name: 'Chhatrapati Shivaji Maharaj', city: 'Mumbai', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'BLR', name: 'Kempegowda International', city: 'Bengaluru', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'HYD', name: 'Rajiv Gandhi International', city: 'Hyderabad', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'MAA', name: 'Chennai International', city: 'Chennai', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'CCU', name: 'Netaji Subhas Chandra Bose', city: 'Kolkata', country: 'India', country_code: 'IN', international: true },
  { iata_code: 'GOI', name: 'Goa International', city: 'Goa', country: 'India', country_code: 'IN', international: false },
  { iata_code: 'LKO', name: 'Chaudhary Charan Singh', city: 'Lucknow', country: 'India', country_code: 'IN', international: false },
  { iata_code: 'DXB', name: 'Dubai International', city: 'Dubai', country: 'UAE', country_code: 'AE', international: true },
  { iata_code: 'LHR', name: 'Heathrow Airport', city: 'London', country: 'UK', country_code: 'GB', international: true },
  { iata_code: 'SIN', name: 'Changi Airport', city: 'Singapore', country: 'Singapore', country_code: 'SG', international: true },
  { iata_code: 'BKK', name: 'Suvarnabhumi Airport', city: 'Bangkok', country: 'Thailand', country_code: 'TH', international: true },
  { iata_code: 'JFK', name: 'John F. Kennedy Int\'l', city: 'New York', country: 'USA', country_code: 'US', international: true },
  { iata_code: 'CDG', name: 'Charles de Gaulle', city: 'Paris', country: 'France', country_code: 'FR', international: true },
];

function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

function generatePNR() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function seed() {
  console.log('[Seed] Starting data seeding...');

  // ── Tenants ────────────────────────────────────────────────────────────────
  const tenants = AIRLINES.map(a => ({
    tenant_id: uuidv4(),
    iata_code: a.iata_code,
    airline_name: a.name,
    logo_url: a.logo,
    base_currency: 'INR',
    config: JSON.stringify({
      overbookingPct: 7 + Math.random() * 5,
      dynamicPricing: true,
      loyaltyProgram: a.iata_code === 'AI' ? 'Flying Returns' : 'EdgeRewards',
    }),
    active: true,
  }));
  tenants.forEach(t => db.memInsert('tenants', t));

  // ── Airports ───────────────────────────────────────────────────────────────
  AIRPORTS.forEach(a => {
    db.memInsert('airports', { airport_id: uuidv4(), ...a });
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const passwordHash = bcrypt.hashSync('admin123', 10);
  const passengers = [
    {
      user_id: uuidv4(), email: 'ankit@skyplatform.in',
      password_hash: passwordHash, first_name: 'Ankit', last_name: 'Aman',
      phone: '+91-9876543210', nationality: 'IN', loyalty_tier: 'GOLD',
      loyalty_points: 24500, role: 'admin',
      preferences: JSON.stringify({ cabin: 'ECONOMY', meal: 'VEG', window: true }),
    },
    {
      user_id: uuidv4(), email: 'priya@example.com',
      password_hash: bcrypt.hashSync('pass123', 10), first_name: 'Priya', last_name: 'Sharma',
      phone: '+91-9812345678', nationality: 'IN', loyalty_tier: 'SILVER',
      loyalty_points: 8200, role: 'passenger',
      preferences: JSON.stringify({ cabin: 'BUSINESS', meal: 'VEGAN', window: false }),
    },
    {
      user_id: uuidv4(), email: 'rahul@example.com',
      password_hash: bcrypt.hashSync('pass123', 10), first_name: 'Rahul', last_name: 'Verma',
      phone: '+91-9934567890', nationality: 'IN', loyalty_tier: 'BLUE',
      loyalty_points: 1200, role: 'passenger',
      preferences: JSON.stringify({ cabin: 'ECONOMY', meal: 'NON_VEG', window: true }),
    },
  ];
  passengers.forEach(u => db.memInsert('users', u));

  // ── Flights (50 flights across 7 days) ────────────────────────────────────
  const routes = [
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

  const departureTimes = ['05:30', '07:45', '09:15', '11:30', '14:00', '16:30', '18:45', '20:15', '22:00'];
  const now = new Date();

  const flights = [];
  for (let day = 0; day < 14; day++) {
    for (const route of routes) {
      const airline = tenants[Math.floor(Math.random() * tenants.length)];
      const timeStr = departureTimes[Math.floor(Math.random() * departureTimes.length)];
      const depDate = new Date(now);
      depDate.setDate(depDate.getDate() + day);
      depDate.setHours(parseInt(timeStr.split(':')[0]), parseInt(timeStr.split(':')[1]), 0, 0);
      const arrDate = addMinutes(depDate, route.dur);

      const flightNum = `${airline.iata_code}${100 + Math.floor(Math.random() * 900)}`;
      const flightId = uuidv4();
      const flight = {
        flight_id: flightId,
        tenant_id: airline.tenant_id,
        flight_number: flightNum,
        aircraft_type: route.dur > 300 ? 'Boeing 787' : 'Airbus A320',
        origin_iata: route.o,
        dest_iata: route.d,
        departure_time: depDate.toISOString(),
        arrival_time: arrDate.toISOString(),
        duration_minutes: route.dur,
        stops: 0,
        status: 'SCHEDULED',
        delay_minutes: 0,
      };
      flights.push(flight);
      db.memInsert('flights', flight);

      // Inventory per cabin
      const cabins = [
        { cabin: 'ECONOMY', seats: 150, ob: 7, fare: route.base },
        { cabin: 'BUSINESS', seats: 24, ob: 3, fare: route.base * 3.2 },
        { cabin: 'FIRST', seats: 8, ob: 0, fare: route.base * 6.5 },
      ];
      for (const cab of cabins) {
        db.memInsert('flight_inventory', {
          inventory_id: uuidv4(),
          flight_id: flightId,
          cabin_class: cab.cabin,
          physical_seats: cab.seats,
          overbooking_pct: cab.ob,
          actual_capacity: Math.ceil(cab.seats * (1 + cab.ob / 100)),
          allocated_seats: Math.floor(Math.random() * cab.seats * 0.6),
          locked_seats: 0,
          base_fare: cab.fare,
          version: 0,
        });
      }
    }
  }

  // ── AB Tests ───────────────────────────────────────────────────────────────
  db.memInsert('ab_tests', {
    test_id: uuidv4(),
    name: 'price_sensitivity_v3',
    description: 'Testing demand factor multiplier aggressiveness',
    status: 'ACTIVE',
    variants: JSON.stringify({
      control: { demand_factor_scale: 1.0, velocity_scale: 1.0 },
      variant_a: { demand_factor_scale: 1.05, velocity_scale: 0.9 },
      variant_b: { demand_factor_scale: 1.0, load_threshold: 0.80 },
    }),
    traffic_split: JSON.stringify({ control: 33, variant_a: 33, variant_b: 34 }),
    metrics: JSON.stringify(['conversion_rate', 'revenue_per_search', 'abandonment_rate']),
  });

  // ── Coupons ────────────────────────────────────────────────────────────────
  const coupons = [
    { code: 'FIRST10', type: 'PERCENT', value: 10, min_fare: 2000, max_discount: 800 },
    { code: 'FLAT500', type: 'FIXED', value: 500, min_fare: 3000, max_discount: 500 },
    { code: 'GOLD20', type: 'PERCENT', value: 20, min_fare: 5000, max_discount: 2000 },
    { code: 'WELCOME', type: 'PERCENT', value: 15, min_fare: 1000, max_discount: 1200 },
  ];
  coupons.forEach(c => {
    db.memInsert('coupons', {
      coupon_id: uuidv4(), ...c, usage_limit: 100, usage_count: 0,
      valid_from: new Date().toISOString(),
      valid_to: new Date(Date.now() + 90 * 86400000).toISOString(),
      active: true,
    });
  });

  console.log(`[Seed] ✅ ${tenants.length} airlines, ${AIRPORTS.length} airports, ${flights.length} flights`);
  console.log(`[Seed] ✅ ${passengers.length} users, ${coupons.length} coupons, 1 AB test`);
  console.log('[Seed] Complete.');
}

module.exports = { seed, generatePNR };

// Run directly: node server/db/seed.js
if (require.main === module) {
  seed().catch(console.error);
}
