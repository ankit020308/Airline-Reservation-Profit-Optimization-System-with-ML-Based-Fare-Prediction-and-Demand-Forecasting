'use strict';

/**
 * Analytics Service — Revenue metrics, booking trends, operational KPIs
 * Phase 1 P0: All aggregations now run against PostgreSQL.
 */

const db    = require('../../db');
const cache = require('../cache/cacheService');

async function getRevenueAnalytics() {
  return cache.getOrSet('analytics:revenue', async () => {

    // ── Revenue by day (last 14 days) ────────────────────────────────────────
    const { rows: daily } = await db.readQuery(`
      SELECT
        DATE(created_at)::text                     AS date,
        COALESCE(SUM(total_fare), 0)::int          AS revenue,
        COUNT(*)::int                               AS bookings
      FROM bookings
      WHERE status = 'CONFIRMED'
        AND created_at >= NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    // Fill in gaps so we always return 14 days
    const now = new Date();
    const dailyMap = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dailyMap[key] = { date: key, revenue: 0, bookings: 0 };
    }
    daily.forEach(r => { if (dailyMap[r.date]) { dailyMap[r.date].revenue = r.revenue; dailyMap[r.date].bookings = r.bookings; } });

    // ── Revenue by cabin ──────────────────────────────────────────────────────
    const { rows: byCabin } = await db.readQuery(`
      SELECT cabin_class, COALESCE(SUM(total_fare), 0)::int AS revenue
      FROM bookings WHERE status = 'CONFIRMED'
      GROUP BY cabin_class
    `);

    // ── Top routes ────────────────────────────────────────────────────────────
    const { rows: topRoutes } = await db.readQuery(`
      SELECT CONCAT(f.origin_iata, '→', f.dest_iata) AS route,
             COALESCE(SUM(b.total_fare), 0)::int       AS revenue
      FROM bookings b
      JOIN flights f ON f.flight_id = b.flight_id
      WHERE b.status = 'CONFIRMED'
      GROUP BY route ORDER BY revenue DESC LIMIT 10
    `);

    // ── KPIs ──────────────────────────────────────────────────────────────────
    const { rows: kpiRows } = await db.readQuery(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'CONFIRMED' THEN total_fare END), 0)::int     AS total_revenue,
        COALESCE(AVG(CASE WHEN status = 'CONFIRMED' THEN total_fare END), 0)::int     AS avg_booking_value,
        COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END)::int                          AS total_bookings,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END)::int                          AS cancelled,
        COUNT(*)::int                                                                   AS total
      FROM bookings
    `);
    const kpi = kpiRows[0];

    // ── Avg load factor ────────────────────────────────────────────────────────
    const { rows: lfRows } = await db.readQuery(`
      SELECT ROUND(AVG(allocated_seats::numeric / NULLIF(actual_capacity, 0)) * 100, 1) AS avg_lf
      FROM flight_inventory
    `);

    // ── Flight status counts ───────────────────────────────────────────────────
    const { rows: flightCounts } = await db.readQuery(`
      SELECT
        COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END)::int AS scheduled,
        COUNT(CASE WHEN status = 'DELAYED'   THEN 1 END)::int AS delayed
      FROM flights
    `);

    // ── Notification stats ─────────────────────────────────────────────────────
    const { rows: notifRows } = await db.readQuery(`
      SELECT COUNT(*)::int AS total,
             COUNT(CASE WHEN status = 'QUEUED' THEN 1 END)::int AS queued
      FROM notifications
    `);

    const totalRevenue = kpi.total_revenue;
    const cabinRevMap = { ECONOMY: 0, BUSINESS: 0, FIRST: 0 };
    byCabin.forEach(r => { cabinRevMap[r.cabin_class] = r.revenue; });

    return {
      kpis: {
        totalRevenue:      totalRevenue,
        avgBookingValue:   kpi.avg_booking_value,
        totalBookings:     kpi.total_bookings,
        avgLoadFactor:     parseFloat(lfRows[0]?.avg_lf || 0),
        cancellationRate:  kpi.total > 0 ? parseFloat(((kpi.cancelled / kpi.total) * 100).toFixed(1)) : 0,
        activeFlights:     flightCounts[0]?.scheduled || 0,
        delayedFlights:    flightCounts[0]?.delayed   || 0,
      },
      dailyRevenue: Object.values(dailyMap),
      revenueByClass: Object.entries(cabinRevMap).map(([cabin, rev]) => ({
        cabin, revenue: rev,
        percentage: totalRevenue > 0 ? parseFloat(((rev / totalRevenue) * 100).toFixed(1)) : 0,
      })),
      topRoutes,
      notifications: notifRows[0] || { total: 0, queued: 0 },
    };
  }, 60);
}

async function getBookingFunnel() {
  const { rows } = await db.readQuery(`
    SELECT status, COUNT(*)::int AS count FROM bookings GROUP BY status
  `);
  const { rows: searchRows } = await db.readQuery(`
    SELECT COUNT(*)::int AS count FROM user_behavior WHERE event_type = 'search_performed'
  `);

  const byStatus = {};
  rows.forEach(r => { byStatus[r.status] = r.count; });

  return {
    stages: [
      { stage: 'Searches',  count: searchRows[0]?.count || 0 },
      { stage: 'Initiated', count: (byStatus['INITIATED'] || 0) + Object.values(byStatus).reduce((a, b) => a + b, 0) },
      { stage: 'Hold',      count: byStatus['HOLD']      || 0 },
      { stage: 'Confirmed', count: byStatus['CONFIRMED'] || 0 },
      { stage: 'Cancelled', count: byStatus['CANCELLED'] || 0 },
    ],
  };
}

module.exports = { getRevenueAnalytics, getBookingFunnel };
