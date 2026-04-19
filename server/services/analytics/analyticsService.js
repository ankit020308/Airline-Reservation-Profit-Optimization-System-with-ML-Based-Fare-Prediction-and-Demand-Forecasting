'use strict';

/**
 * Analytics Service — Revenue metrics, booking trends, operational KPIs
 */

const db = require('../../db');
const cache = require('../cache/cacheService');

function getRevenueAnalytics() {
  return cache.getOrSet('analytics:revenue', async () => {
    const bookings = db.memFind('bookings', b => b.status === 'CONFIRMED');
    const now = new Date();

    // Revenue by day (last 14 days)
    const daily = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      daily[key] = { date: key, revenue: 0, bookings: 0 };
    }

    bookings.forEach(b => {
      const day = b.created_at ? b.created_at.split('T')[0] : null;
      if (day && daily[day]) {
        daily[day].revenue += parseFloat(b.total_fare);
        daily[day].bookings++;
      }
    });

    // Revenue by cabin
    const byCabin = { ECONOMY: 0, BUSINESS: 0, FIRST: 0 };
    bookings.forEach(b => { byCabin[b.cabin_class] = (byCabin[b.cabin_class] || 0) + parseFloat(b.total_fare); });

    // Revenue by route
    const byRoute = {};
    bookings.forEach(b => {
      const flight = db.memFindOne('flights', f => f.flight_id === b.flight_id);
      if (flight) {
        const route = `${flight.origin_iata}→${flight.dest_iata}`;
        byRoute[route] = (byRoute[route] || 0) + parseFloat(b.total_fare);
      }
    });
    const topRoutes = Object.entries(byRoute)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([route, revenue]) => ({ route, revenue: Math.round(revenue) }));

    // KPIs
    const totalRevenue = bookings.reduce((s, b) => s + parseFloat(b.total_fare), 0);
    const avgBookingValue = bookings.length > 0 ? totalRevenue / bookings.length : 0;

    // Inventory stats
    const allInventory = db.memFind('flight_inventory', () => true);
    const avgLoadFactor = allInventory.length > 0
      ? allInventory.reduce((s, i) => s + (i.allocated_seats / i.actual_capacity), 0) / allInventory.length
      : 0;

    // Cancellation rate
    const cancelled = db.memFind('bookings', b => b.status === 'CANCELLED').length;
    const total = db.memFind('bookings', () => true).length;
    const cancellationRate = total > 0 ? ((cancelled / total) * 100).toFixed(1) : '0.0';

    // Notifications
    const notifStats = {
      total: db.memFind('notifications', () => true).length,
      queued: db.memFind('notifications', n => n.status === 'QUEUED').length,
    };

    return {
      kpis: {
        totalRevenue: Math.round(totalRevenue),
        avgBookingValue: Math.round(avgBookingValue),
        totalBookings: bookings.length,
        avgLoadFactor: parseFloat((avgLoadFactor * 100).toFixed(1)),
        cancellationRate: parseFloat(cancellationRate),
        activeFlights: db.memFind('flights', f => f.status === 'SCHEDULED').length,
        delayedFlights: db.memFind('flights', f => f.status === 'DELAYED').length,
      },
      dailyRevenue: Object.values(daily),
      revenueByClass: Object.entries(byCabin).map(([cabin, rev]) => ({
        cabin, revenue: Math.round(rev),
        percentage: totalRevenue > 0 ? parseFloat(((rev / totalRevenue) * 100).toFixed(1)) : 0,
      })),
      topRoutes,
      notifications: notifStats,
    };
  }, 60); // 60-second cache
}

function getBookingFunnel() {
  const all = db.memFind('bookings', () => true);
  const byStatus = {};
  all.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });
  return {
    stages: [
      { stage: 'Searches', count: db.memFind('user_behavior', e => e.event_type === 'search_performed').length },
      { stage: 'Initiated', count: (byStatus['INITIATED'] || 0) + (all.length) },
      { stage: 'Hold', count: byStatus['HOLD'] || 0 },
      { stage: 'Confirmed', count: byStatus['CONFIRMED'] || 0 },
      { stage: 'Cancelled', count: byStatus['CANCELLED'] || 0 },
    ],
  };
}

module.exports = { getRevenueAnalytics, getBookingFunnel };
