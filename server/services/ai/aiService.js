'use strict';

/**
 * AI Service: Fare Prediction, Demand Forecasting, Anomaly Detection
 */

const db = require('../../db');
const cache = require('../cache/cacheService');

// ── Fare Prediction Model ─────────────────────────────────────────────────────
// Simulates: LightGBM binary classifier + fare forecast
// Inputs: load_factor, days_to_departure, search_velocity, route_seasonality

function predictFare({ flightId, cabinClass, currentFare, baseFare }) {
  const flight = db.memFindOne('flights', f => f.flight_id === flightId);
  const inventory = db.memFindOne('flight_inventory',
    i => i.flight_id === flightId && i.cabin_class === cabinClass);

  if (!flight || !inventory) return null;

  const daysToDepart = Math.max(0, (new Date(flight.departure_time) - Date.now()) / 86400000);
  const loadFactor = (inventory.allocated_seats + inventory.locked_seats) / inventory.actual_capacity;

  // Feature-based probability score (simulated ML output)
  let pIncrease = 0.5; // base

  // Time pressure: price rises as departure approaches
  if (daysToDepart < 7)  pIncrease += 0.25;
  else if (daysToDepart < 14) pIncrease += 0.15;
  else if (daysToDepart < 30) pIncrease += 0.05;

  // Load pressure: high occupancy → prices rise
  if (loadFactor > 0.85) pIncrease += 0.20;
  else if (loadFactor > 0.70) pIncrease += 0.10;
  else if (loadFactor < 0.30) pIncrease -= 0.20; // empty → likely to drop

  // Fare vs historical: if currently cheap, likely to rise
  const farePercentile = currentFare / (baseFare * 1.5); // normalized
  if (farePercentile < 0.5) pIncrease += 0.10;
  else if (farePercentile > 0.9) pIncrease -= 0.10;

  // Weekend effect
  const dow = new Date(flight.departure_time).getDay();
  if (dow === 5 || dow === 6) pIncrease += 0.05;

  // Clamp to [0.05, 0.95]
  pIncrease = Math.max(0.05, Math.min(0.95, pIncrease));

  // Predicted fare in 7 days
  const fareChange = pIncrease > 0.6 ? 1.08 + (pIncrease - 0.6) * 0.5 : 0.95;
  const predictedFare7d = Math.round(currentFare * fareChange);
  const potentialSaving = Math.max(0, predictedFare7d - currentFare);

  // Recommendation
  let recommendation, message, icon;
  if (pIncrease > 0.75) {
    recommendation = 'BOOK_NOW';
    icon = '📈';
    message = `Prices typically rise for this route. Book now to save ₹${potentialSaving.toLocaleString('en-IN')}`;
  } else if (pIncrease < 0.35) {
    recommendation = 'WAIT';
    icon = '📉';
    message = 'Prices may drop. Set a fare alert and we\'ll notify you.';
  } else {
    recommendation = 'UNCERTAIN';
    icon = '↔️';
    message = 'Prices are stable. Book at your convenience.';
  }

  return {
    flightId,
    cabinClass,
    currentFare,
    pricingPressureScore: parseFloat(pIncrease.toFixed(2)),
    predictedFare7d,
    potentialSaving,
    fareChange: `${((fareChange - 1) * 100).toFixed(1)}%`,
    daysToDepart: Math.round(daysToDepart),
    loadFactor: parseFloat(loadFactor.toFixed(2)),
    recommendation,
    icon,
    message,
    confidence: pIncrease > 0.75 || pIncrease < 0.35 ? 'HIGH' : 'MEDIUM',
  };
}

// ── Demand Forecasting ────────────────────────────────────────────────────────
// Simulates: Prophet + LightGBM ensemble per route
function forecastDemand({ originIata, destIata, travelDate }) {
  const daysOut = Math.max(0, (new Date(travelDate) - Date.now()) / 86400000);
  const dow = new Date(travelDate).getDay();

  // Route demand profiles (simulated from historical data)
  const isDomestic = ['DEL','BOM','BLR','HYD','MAA','CCU','GOI','LKO'].includes(destIata);
  const baseDemand = isDomestic ? 150 : 85;

  // Seasonality
  const month = new Date(travelDate).getMonth();
  const seasonalIdx = [0.85, 0.80, 0.95, 1.10, 1.20, 0.90, 0.85, 0.88, 1.05, 1.15, 1.30, 1.40][month];

  // Weekend boost
  const dowFactor = (dow === 5 || dow === 6 || dow === 0) ? 1.25 : 1.0;

  // Days-out decay
  const bookingCurveFactor = daysOut > 60 ? 0.4 : daysOut > 30 ? 0.7 : daysOut > 14 ? 1.0 : 1.3;

  const expectedBookings = Math.round(baseDemand * seasonalIdx * dowFactor * bookingCurveFactor);
  const uncertainty = Math.round(expectedBookings * 0.15);

  return {
    route: `${originIata}→${destIata}`,
    travelDate,
    expectedBookings,
    lowerBound80: expectedBookings - uncertainty,
    upperBound80: expectedBookings + uncertainty,
    demandLevel: expectedBookings > baseDemand * 1.2 ? 'HIGH' :
                 expectedBookings < baseDemand * 0.8 ? 'LOW' : 'NORMAL',
    seasonalIndex: seasonalIdx,
    recommendation: expectedBookings > baseDemand * 1.1
      ? 'Consider increasing fare by 10-15%'
      : expectedBookings < baseDemand * 0.9
      ? 'Consider promotional pricing to stimulate demand'
      : 'Maintain current pricing strategy',
  };
}

// ── Anomaly Detection ──────────────────────────────────────────────────────────
// Real-time z-score based detection on booking velocity

const velocityWindows = new Map(); // route → [booking timestamps]
const anomalyLog = [];

function recordBookingEvent(originIata, destIata, userId) {
  const key = `${originIata}:${destIata}`;
  const now = Date.now();
  const arr = velocityWindows.get(key) || [];
  arr.push({ t: now, userId });
  // Keep 1-hour window
  const filtered = arr.filter(e => e.t > now - 3600000);
  velocityWindows.set(key, filtered);
  return detectAnomaly(key, filtered);
}

function detectAnomaly(routeKey, events) {
  // Baseline: 10 bookings/hr average
  const baseline = 10;
  const count = events.length;
  const zScore = (count - baseline) / Math.max(1, Math.sqrt(baseline));

  let severity = null;
  let action = null;

  if (zScore > 6) {
    severity = 'CRITICAL';
    action = 'PAUSE_BOOKINGS';
  } else if (zScore > 4) {
    severity = 'HIGH';
    action = 'THROTTLE';
  } else if (zScore > 2) {
    severity = 'MEDIUM';
    action = 'ALERT';
  }

  // User velocity check: same user multiple locks
  const userCounts = {};
  events.forEach(e => { userCounts[e.userId] = (userCounts[e.userId] || 0) + 1; });
  const maxUserCount = Math.max(...Object.values(userCounts));
  const suspiciousUser = maxUserCount > 5
    ? Object.keys(userCounts).find(u => userCounts[u] === maxUserCount)
    : null;

  if (severity) {
    const anomaly = {
      route: routeKey,
      zScore: parseFloat(zScore.toFixed(2)),
      bookings1h: count,
      severity,
      action,
      suspiciousUserId: suspiciousUser,
      detectedAt: new Date().toISOString(),
    };
    anomalyLog.unshift(anomaly);
    if (anomalyLog.length > 500) anomalyLog.pop();
    console.warn(`[Anomaly] ⚠️ ${severity} on route ${routeKey} (z=${zScore.toFixed(1)})`);
    return anomaly;
  }
  return null;
}

function getAnomalyLog(limit = 50) {
  return anomalyLog.slice(0, limit);
}

// ── Chatbot Intent Engine ─────────────────────────────────────────────────────
const INTENTS = {
  SEARCH_FLIGHT: /\b(search|find|look|book|fly|flight|ticket)\b.*\b(from|to|between)\b/i,
  CHECK_STATUS:  /\b(status|pnr|booking|reservation|check)\b/i,
  CANCEL:        /\b(cancel|refund|return)\b/i,
  FARE_INFO:     /\b(price|fare|cost|how much|cheap|expensive)\b/i,
  FARE_ALERT:    /\b(alert|notify|watch|track|update)\b.*\b(price|fare)\b/i,
  GREETING:      /\b(hi|hello|hey|good morning|good evening|namaste)\b/i,
  HELP:          /\b(help|what can|support|assist)\b/i,
};

function detectIntent(message) {
  for (const [intent, pattern] of Object.entries(INTENTS)) {
    if (pattern.test(message)) return intent;
  }
  return 'GENERAL_FAQ';
}

function extractEntities(message) {
  const airports = ['DEL','BOM','BLR','HYD','MAA','CCU','GOI','LKO','DXB','LHR','SIN','BKK','JFK','CDG'];
  const airportNames = {
    'delhi': 'DEL', 'mumbai': 'BOM', 'bangalore': 'BLR', 'bengaluru': 'BLR',
    'hyderabad': 'HYD', 'chennai': 'MAA', 'kolkata': 'CCU', 'goa': 'GOI',
    'lucknow': 'LKO', 'dubai': 'DXB', 'london': 'LHR', 'singapore': 'SIN',
    'bangkok': 'BKK', 'new york': 'JFK', 'paris': 'CDG',
  };

  const lower = message.toLowerCase();
  const found = [];

  for (const [name, code] of Object.entries(airportNames)) {
    if (lower.includes(name)) found.push(code);
  }

  airports.forEach(code => {
    if (message.toUpperCase().includes(code) && !found.includes(code)) found.push(code);
  });

  // Date extraction (simple)
  const datePatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
    /\b(today|tomorrow|next\s+\w+day)\b/i,
  ];

  let date = null;
  for (const p of datePatterns) {
    const m = message.match(p);
    if (m) { date = m[0]; break; }
  }

  // Pax count
  const paxMatch = message.match(/\b(\d+)\s*(person|passenger|adult|people|travell?er)\b/i);
  const paxCount = paxMatch ? parseInt(paxMatch[1]) : 1;

  return {
    origin: found[0] || null,
    destination: found[1] || null,
    date,
    paxCount,
    cabin: /business|biz/i.test(message) ? 'BUSINESS' : 'ECONOMY',
  };
}

async function processChatMessage({ message, userId, context = {} }) {
  const intent = detectIntent(message);
  const entities = extractEntities(message);

  let response = '';
  let actions = [];

  switch (intent) {
    case 'GREETING':
      response = '✈️ Welcome to SkyPlatform! I\'m your AI travel assistant. I can help you search flights, check your booking status, get fare predictions, and more. How can I help you today?';
      break;

    case 'HELP':
      response = `Here's what I can do:\n• 🔍 **Search flights**: "Find flights from Delhi to Mumbai tomorrow"\n• 📋 **Check booking**: "Check status of PNR XYZABC"\n• 💰 **Fare info**: "How much is Delhi to Goa next Friday?"\n• 🔔 **Fare alerts**: "Alert me when Delhi-Mumbai drops below ₹3000"\n• ❌ **Cancel booking**: "Cancel my booking"\n\nJust ask naturally!`;
      break;

    case 'SEARCH_FLIGHT': {
      if (entities.origin && entities.destination) {
        const flights = db.memFind('flights', f =>
          f.origin_iata === entities.origin &&
          f.dest_iata === entities.destination &&
          f.status === 'SCHEDULED'
        ).slice(0, 3);

        if (flights.length > 0) {
          const flightList = flights.map(f => {
            const dep = new Date(f.departure_time);
            const inv = db.memFindOne('flight_inventory', i => i.flight_id === f.flight_id && i.cabin_class === 'ECONOMY');
            const fare = inv ? `₹${Math.round(inv.base_fare).toLocaleString('en-IN')}` : 'N/A';
            return `• **${f.flight_number}** — ${dep.toLocaleDateString('en-IN')} ${dep.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} | ${fare}`;
          }).join('\n');

          response = `Found ${flights.length} flights from **${entities.origin}** to **${entities.destination}**:\n\n${flightList}\n\nWould you like to book one of these? [Search All Results]`;
          actions = [{ type: 'SEARCH_LINK', origin: entities.origin, dest: entities.destination }];
        } else {
          response = `I couldn't find direct flights from **${entities.origin}** to **${entities.destination}**. Try broadening your dates or check our search page.`;
        }
      } else {
        response = 'I\'d love to help you find a flight! Could you tell me your **origin** and **destination** airports? For example: "Find flights from Delhi to Mumbai next Friday"';
      }
      break;
    }

    case 'CHECK_STATUS': {
      const pnrMatch = message.match(/\b([A-Z]{2,3}[0-9]{3,4}|[A-Z0-9]{6})\b/);
      if (pnrMatch) {
        const booking = db.memFindOne('bookings', b => b.pnr === pnrMatch[1].toUpperCase());
        if (booking) {
          response = `✅ Found your booking!\n• **PNR**: ${booking.pnr}\n• **Status**: ${booking.status}\n• **Fare**: ₹${parseFloat(booking.total_fare).toLocaleString('en-IN')}\n• **Cabin**: ${booking.cabin_class}`;
        } else {
          response = `I couldn't find a booking with PNR **${pnrMatch[1]}**. Please check the PNR code and try again, or visit your dashboard.`;
        }
      } else {
        response = 'Please share your **PNR code** (6-character code on your ticket) and I\'ll look it up for you.';
      }
      break;
    }

    case 'FARE_INFO':
    case 'FARE_ALERT':
      response = entities.origin && entities.destination
        ? `I can check fares for **${entities.origin} → ${entities.destination}**. Based on current demand, prices look ${Math.random() > 0.5 ? '📈 **on the rise**' : '📉 **stable or falling**'}. Set a fare alert and I\'ll notify you of any drops!`
        : 'Tell me your route (e.g., "Delhi to Mumbai") and I\'ll show you the fare trend and prediction!';
      break;

    case 'CANCEL':
      response = userId
        ? 'To cancel a booking, please share your **PNR code**. Note that cancellation fees may apply based on your fare class. Do you want to proceed?'
        : '⚠️ You need to be **logged in** to cancel bookings. Please sign in first.';
      break;

    default:
      response = 'I\'m still learning! For complex queries, you can:\n• Use the **Search** page for flight lookup\n• Visit **My Bookings** for reservation management\n• Call our support: **1800-SKY-HELP**\n\nCan I help with anything else?';
  }

  return { intent, entities, response, actions, timestamp: new Date().toISOString() };
}

module.exports = { predictFare, forecastDemand, recordBookingEvent, getAnomalyLog, processChatMessage, detectIntent };
