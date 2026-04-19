/* ============================================================
   SkyPlatform — Full SPA Application
   Production-grade airline platform frontend
   ============================================================ */
'use strict';

const API = '';     // same origin
let socket = null;
let authToken = null;
let currentUser = null;

// ── Utility Functions ────────────────────────────────────────
const $ = id => document.getElementById(id);
const formatINR = n => '₹' + Math.round(n).toLocaleString('en-IN');
const formatDate = d => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const formatTime = d => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

function toast(msg, type = 'info', duration = 4000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const idempKey = options.idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {};
  const res = await fetch(API + path, {
    ...options,
    headers: { ...headers, ...idempKey, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}

// ── Auth Token Persistence ────────────────────────────────────
function loadAuth() {
  const stored = localStorage.getItem('sky_auth');
  if (stored) {
    const { token, user, exp } = JSON.parse(stored);
    if (exp > Date.now()) { authToken = token; currentUser = user; return true; }
    localStorage.removeItem('sky_auth');
  }
  return false;
}

function saveAuth(token, user, expiresIn) {
  authToken = token; currentUser = user;
  localStorage.setItem('sky_auth', JSON.stringify({ token, user, exp: Date.now() + expiresIn * 1000 }));
}

function clearAuth() {
  authToken = null; currentUser = null;
  localStorage.removeItem('sky_auth');
}

// ── Router ────────────────────────────────────────────────────
const routes = {
  home:        renderHome,
  results:     renderResults,
  booking:     renderBooking,
  dashboard:   renderDashboard,
  analytics:   renderAnalytics,
  admin:       renderAdmin,
  live:        renderLiveBoard,
};

let currentRoute = 'home';
let routeParams = {};

function navigate(route, params = {}) {
  currentRoute = route;
  routeParams = params;
  renderNav();
  const container = $('page-container');
  if (!container) return;
  container.innerHTML = '';
  container.style.opacity = '0';
  const fn = routes[route] || renderHome;
  fn(container, params);
  requestAnimationFrame(() => {
    container.style.transition = 'opacity 0.25s ease';
    container.style.opacity = '1';
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Navigation ─────────────────────────────────────────────────
function renderNav() {
  let nav = document.querySelector('.nav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'nav';
    document.body.insertBefore(nav, $('page-container') || document.body.firstChild);
  }

  const navLinks = [
    { id: 'home', label: '🏠 Home' },
    { id: 'live', label: '📡 Live Board' },
    ...(currentUser ? [{ id: 'dashboard', label: '📋 My Bookings' }] : []),
    ...(currentUser?.role === 'admin' ? [
      { id: 'analytics', label: '📊 Analytics' },
      { id: 'admin', label: '⚙️ Admin' },
    ] : []),
  ];

  nav.innerHTML = `
    <div class="nav-logo" onclick="navigate('home')">Zenith Optima</div>
    <div class="nav-links">
      ${navLinks.map(l => `
        <button class="nav-link ${currentRoute === l.id ? 'active' : ''}" onclick="navigate('${l.id}')">
          ${l.label}
        </button>`).join('')}
    </div>
    <div class="nav-actions">
      ${currentUser ? `
        <div class="nav-user" onclick="navigate('dashboard')">
          <div class="nav-avatar">${(currentUser.firstName || 'U')[0].toUpperCase()}</div>
          <span style="font-size:0.85rem">${currentUser.firstName}</span>
          <span class="loyalty-badge tier-${currentUser.loyaltyTier}">${currentUser.loyaltyTier}</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="App.logout()">Logout</button>
      ` : `
        <button class="btn btn-secondary btn-sm" onclick="App.showAuthModal('login')">Sign In</button>
        <button class="btn btn-primary btn-sm" onclick="App.showAuthModal('register')">Join Free</button>
      `}
    </div>
  `;
}

// ── Home Page ─────────────────────────────────────────────────
function renderHome(container) {
  container.innerHTML = hero() + featuredRoutes() + livePreview();
  initStars();
  loadAirports();
  initHomeChatbotWelcome();
}

function hero() {
  return `
  <div class="hero">
    <div class="hero-stars" id="hero-stars"></div>
    <div class="hero-content">
      <div class="hero-badge">🤖 AI-Powered · Profit Optimization · Real-Time Systems</div>
      <h1 class="hero-title">Intelligent Airline<br>Revenue Engine</h1>
      <p class="hero-subtitle">Book smarter with AI fare prediction, real-time seat availability, and personalized recommendations across India's top airlines.</p>
      <div class="search-card" id="search-card">
        <div class="search-tabs">
          <button class="search-tab active" id="tab-one">One Way</button>
          <button class="search-tab" id="tab-round">Round Trip</button>
          <button class="search-tab" id="tab-multi">Multi-City</button>
        </div>
        <div class="search-fields">
          <div class="search-field">
            <label>From</label>
            <input type="text" id="s-origin" placeholder="City or Airport" value="DEL" list="airport-list" />
          </div>
          <button class="swap-btn" onclick="swapAirports()" title="Swap">⇄</button>
          <div class="search-field">
            <label>To</label>
            <input type="text" id="s-dest" placeholder="City or Airport" value="BOM" list="airport-list" />
          </div>
          <div class="search-field">
            <label>Departure</label>
            <input type="date" id="s-date" />
          </div>
          <div class="search-field">
            <label>Cabin & Pax</label>
            <select id="s-cabin">
              <option value="ECONOMY">Economy</option>
              <option value="BUSINESS">Business</option>
              <option value="FIRST">First Class</option>
            </select>
          </div>
        </div>
        <div class="flex" style="gap:12px;margin-top:20px;align-items:center;flex-wrap:wrap">
          <div class="search-field" style="min-width:120px">
            <label>Passengers</label>
            <input type="number" id="s-pax" value="1" min="1" max="9" />
          </div>
          <button class="btn btn-primary btn-lg" style="flex:1;margin-top:20px" onclick="doSearch()">
            🔍 Search Flights
          </button>
          <button class="btn btn-ghost btn-sm" onclick="navigate('live')" style="margin-top:20px">
            📡 Live Board
          </button>
        </div>
        <datalist id="airport-list">
          <option value="DEL">Delhi (Indira Gandhi)</option>
          <option value="BOM">Mumbai (Chhatrapati Shivaji)</option>
          <option value="BLR">Bengaluru (Kempegowda)</option>
          <option value="HYD">Hyderabad (Rajiv Gandhi)</option>
          <option value="MAA">Chennai International</option>
          <option value="CCU">Kolkata (Netaji Subhas)</option>
          <option value="GOI">Goa International</option>
          <option value="LKO">Lucknow (Chaudhary Charan Singh)</option>
          <option value="DXB">Dubai International</option>
          <option value="LHR">London Heathrow</option>
          <option value="SIN">Singapore Changi</option>
          <option value="BKK">Bangkok Suvarnabhumi</option>
          <option value="JFK">New York JFK</option>
          <option value="CDG">Paris Charles de Gaulle</option>
        </datalist>
      </div>
    </div>
  </div>`;
}

function featuredRoutes() {
  const routes = [
    { o:'DEL', d:'BOM', label:'Delhi → Mumbai', emoji:'🏙️', fare:'from ₹2,999' },
    { o:'BOM', d:'BLR', label:'Mumbai → Bengaluru', emoji:'🌆', fare:'from ₹2,499' },
    { o:'DEL', d:'DXB', label:'Delhi → Dubai', emoji:'🌴', fare:'from ₹9,999' },
    { o:'DEL', d:'SIN', label:'Delhi → Singapore', emoji:'🦁', fare:'from ₹13,999' },
  ];
  return `
  <div class="section">
    <div class="section-header">
      <h2 class="section-title"><span>🔥</span>Popular Routes</h2>
      <div id="recs-loading" style="font-size:0.8rem;color:var(--text-muted)">Loading personalized picks...</div>
    </div>
    <div class="stats-grid" id="popular-routes">
      ${routes.map(r => `
        <div class="stat-card" onclick="quickSearch('${r.o}','${r.d}')" style="cursor:pointer">
          <div style="font-size:2rem;margin-bottom:8px">${r.emoji}</div>
          <div class="stat-label">${r.label}</div>
          <div class="stat-value gradient-text" style="font-size:1.2rem">${r.fare}</div>
          <div class="text-xs text-muted mt-8">Click to search →</div>
        </div>`).join('')}
    </div>
    <div id="ai-recommendations" style="margin-top:28px"></div>
  </div>`;
}

function livePreview() {
  return `
  <div class="section" style="padding-top:0">
    <div class="section-header">
      <h2 class="section-title">
        <span><div class="live-dot" style="display:inline-block"></div></span>
        Live Operations
      </h2>
      <button class="btn btn-ghost btn-sm" onclick="navigate('live')">View All →</button>
    </div>
    <div class="card" id="live-preview">
      <div class="skeleton skeleton-flight"></div>
      <div class="skeleton skeleton-flight"></div>
      <div class="skeleton skeleton-flight"></div>
    </div>
  </div>`;
}

function initStars() {
  const container = $('hero-stars');
  if (!container) return;
  for (let i = 0; i < 80; i++) {
    const star = document.createElement('div');
    star.className = 'hero-star';
    star.style.cssText = `
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 100}%;
      animation-delay: ${Math.random() * 4}s;
      animation-duration: ${2 + Math.random() * 3}s;
      width: ${Math.random() > 0.8 ? 3 : 2}px;
      height: ${Math.random() > 0.8 ? 3 : 2}px;
    `;
    container.appendChild(star);
  }
}

function swapAirports() {
  const o = $('s-origin'); const d = $('s-dest');
  [o.value, d.value] = [d.value, o.value];
}

function quickSearch(origin, dest) {
  $('s-origin').value = origin;
  $('s-dest').value = dest;
  doSearch();
}

async function doSearch() {
  const origin = ($('s-origin')?.value || '').toUpperCase().trim();
  const dest   = ($('s-dest')?.value  || '').toUpperCase().trim();
  const date   = $('s-date')?.value || '';
  const cabin  = $('s-cabin')?.value || 'ECONOMY';
  const pax    = parseInt($('s-pax')?.value || 1);

  if (!origin || !dest) { toast('Please enter origin and destination', 'warning'); return; }
  if (origin === dest) { toast('Origin and destination must differ', 'warning'); return; }

  navigate('results', { origin, dest, date, cabin, pax });
}

async function loadAirports() {
  try {
    const data = await apiFetch('/api/airports');
    // Airports loaded for autocomplete
  } catch (_) {}
}

async function loadLivePreview() {
  try {
    const data = await apiFetch('/api/operations/live');
    const el = $('live-preview');
    if (!el) return;
    if (!data.flights?.length) {
      el.innerHTML = '<p class="text-muted text-center" style="padding:24px">No active flights in next 6 hours</p>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Flight</th><th>Route</th><th>Scheduled</th><th>Status</th><th>Delay</th>
          </tr></thead>
          <tbody>
            ${data.flights.slice(0, 8).map(f => `
              <tr class="live-row">
                <td><span class="td-primary">${f.flightNumber}</span><br/><span class="text-xs text-muted">${f.airlineLogo || '✈️'} ${f.airline || ''}</span></td>
                <td>${f.origin} → ${f.destination}</td>
                <td>${formatTime(f.scheduledDeparture)}</td>
                <td><span class="status-chip status-${f.status}">${f.status}</span></td>
                <td>${f.delayMinutes > 0 ? `<span class="delay-badge">+${f.delayMinutes}m</span>` : '<span style="color:var(--brand-success)">On Time</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (_) {}
}

function initHomeChatbotWelcome() {
  // Small delay then show chatbot hint
  setTimeout(() => {
    const badge = $('chatbot-badge');
    if (badge && !currentUser) { badge.style.display = 'flex'; }
  }, 3000);

  // Load live preview
  setTimeout(loadLivePreview, 500);

  // Load AI recommendations if logged in
  if (currentUser) {
    loadRecommendations();
  }
}

async function loadRecommendations() {
  try {
    const data = await apiFetch('/api/recommendations?limit=4');
    const el = $('ai-recommendations');
    const loading = $('recs-loading');
    if (loading) loading.textContent = '✨ AI-Personalized for you';
    if (!el || !data.recommendations?.length) return;

    el.innerHTML = `
      <div class="section-header" style="margin-bottom:16px">
        <h3 style="font-size:1.1rem;color:var(--text-secondary)">✨ Recommended for You</h3>
      </div>
      <div class="stats-grid">
        ${data.recommendations.slice(0, 4).map(r => `
          <div class="card" style="cursor:pointer" onclick="quickSearch('${r.origin}','${r.destination}')">
            <div class="flex-between mb-16">
              <span class="tag">${r.cabin}</span>
              <span class="text-xs text-muted">Score: ${(r.mlScore * 100).toFixed(0)}%</span>
            </div>
            <div style="font-size:1.1rem;font-weight:700">${r.origin} → ${r.destination}</div>
            <div class="text-sm text-muted mt-8">${formatDate(r.departure)}</div>
            <div class="gradient-text" style="font-weight:800;font-size:1.1rem;margin-top:8px">
              ${r.baseFare ? formatINR(r.baseFare) : '—'}
            </div>
            ${r.reasons.length ? `<div class="text-xs text-muted mt-8">${r.reasons[0]}</div>` : ''}
          </div>`).join('')}
      </div>`;
  } catch (_) {}
}

// ── Results Page ───────────────────────────────────────────────
let searchResults = [];
let selectedFlight = null;

async function renderResults(container, params) {
  container.innerHTML = `
    <div class="section">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span>🔍</span>${params.origin || '?'} → ${params.dest || '?'}</h2>
          <p class="text-sm text-muted">${params.date ? formatDate(params.date) : 'All dates'} · ${params.cabin} · ${params.pax} pax</p>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="navigate('home')">← Modify Search</button>
      </div>

      <!-- Filter bar -->
      <div class="card mb-24" style="padding:16px">
        <div class="flex gap-12" style="flex-wrap:wrap;align-items:center">
          <span class="text-sm text-muted">Sort:</span>
          <button class="btn btn-sm btn-primary" id="sort-price" onclick="sortResults('price')">Price ↑</button>
          <button class="btn btn-sm btn-secondary" id="sort-dur" onclick="sortResults('duration')">Duration</button>
          <button class="btn btn-sm btn-secondary" id="sort-dep" onclick="sortResults('departure')">Departure</button>
          <div style="margin-left:auto" class="text-sm text-muted" id="results-count">Loading...</div>
        </div>
      </div>

      <!-- Demand Insight Banner -->
      <div id="demand-banner"></div>

      <!-- Skeleton loader -->
      <div id="results-list">
        ${[1,2,3,4].map(() => `<div class="skeleton skeleton-flight" style="margin-bottom:12px"></div>`).join('')}
      </div>
    </div>`;

  try {
    const qs = new URLSearchParams({
      origin: params.origin, dest: params.dest,
      ...(params.date && { date: params.date }),
      cabin: params.cabin, pax: params.pax, limit: 30,
    });
    const data = await apiFetch(`/api/flights/search?${qs}`);
    searchResults = data.results || [];

    // Demand banner
    if (data.demandInsight) {
      const d = data.demandInsight;
      const color = d.demandLevel === 'HIGH' ? 'var(--brand-warning)' : d.demandLevel === 'LOW' ? 'var(--brand-success)' : 'var(--brand-primary)';
      $('demand-banner').innerHTML = `
        <div class="card mb-24" style="border-color:${color}22;background:${color}0a">
          <div class="flex gap-12 align-items:center">
            <span style="font-size:1.2rem">${d.demandLevel === 'HIGH' ? '🔥' : d.demandLevel === 'LOW' ? '💰' : '📊'}</span>
            <div>
              <div class="font-bold text-sm">${d.demandLevel} demand for ${d.route}</div>
              <div class="text-xs text-muted">${d.recommendation}</div>
            </div>
          </div>
        </div>`;
    }

    $('results-count').textContent = `${searchResults.length} flights found`;
    renderFlightList();
  } catch (err) {
    $('results-list').innerHTML = `
      <div class="card text-center" style="padding:48px">
        <div style="font-size:2.5rem;margin-bottom:16px">🚫</div>
        <h3>No Flights Found</h3>
        <p class="text-muted">${err.message === 'ORIGIN_DEST_REQUIRED' ? 'Please enter a valid route' : 'No flights available for this route and date'}</p>
        <button class="btn btn-primary mt-16" onclick="navigate('home')">Search Again</button>
      </div>`;
  }
}

function sortResults(by) {
  if (by === 'price')    searchResults.sort((a, b) => a.totalFare - b.totalFare);
  if (by === 'duration') searchResults.sort((a, b) => a.durationMinutes - b.durationMinutes);
  if (by === 'departure')searchResults.sort((a, b) => new Date(a.departure) - new Date(b.departure));
  // Update button states
  ['price','dur','dep'].forEach(k => {
    const el = $(`sort-${k}`);
    if (el) el.className = k === by ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
  });
  renderFlightList();
}

function renderFlightList() {
  const list = $('results-list');
  if (!list) return;
  if (!searchResults.length) {
    list.innerHTML = `<div class="card text-center" style="padding:48px"><h3>No flights available</h3></div>`;
    return;
  }
  list.innerHTML = searchResults.map((f, i) => `
    <div class="flight-card ${selectedFlight?.flightId === f.flightId ? 'selected' : ''}"
         id="fc-${f.flightId}"
         onclick="selectFlight('${f.flightId}')">
      <div class="flight-card-inner">
        <div class="flight-airline-logo">${f.airlineLogo || '✈️'}</div>
        <div class="flight-times">
          <div class="flight-time-block">
            <div class="flight-time">${f.departureTime}</div>
            <div class="flight-iata">${f.origin}</div>
          </div>
          <div class="flight-path">
            <div class="flight-line"></div>
          </div>
          <div class="flight-time-block">
            <div class="flight-time">${f.arrivalTime}</div>
            <div class="flight-iata">${f.destination}</div>
          </div>
        </div>
        <div style="text-align:center">
          <div class="flight-duration">${f.duration}</div>
          <div class="flight-stops">${f.stops === 0 ? 'Non-stop' : f.stops + ' stop'}</div>
          <div class="text-xs text-muted mt-8">${f.airline}</div>
          <div class="text-xs text-muted">${f.flightNumber}</div>
        </div>
        <div class="flight-price-block">
          <div class="flight-price">${formatINR(f.totalFare)}</div>
          <div class="flight-price-sub">for ${routeParams.pax || 1} pax</div>
          <div style="margin-top:6px;display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
            <span class="fare-badge">${f.fareBasis}</span>
            ${f.refundable ? '<span class="fare-badge refundable-badge">Refundable</span>' : ''}
          </div>
          <div class="text-xs text-muted mt-8">
            ${f.seatsAvailable} seats left
          </div>
          ${f.status === 'DELAYED' ? `<div class="text-xs text-warning mt-8">⚠️ Delayed +${f.delayMinutes}m</div>` : ''}
        </div>
      </div>
      <div id="pred-${f.flightId}" style="display:none"></div>
    </div>`).join('');

  // Load fare predictions for first 3 results asynchronously
  searchResults.slice(0, 3).forEach(f => loadFarePrediction(f));
}

async function loadFarePrediction(flight) {
  try {
    const data = await apiFetch(`/api/pricing/predict/${flight.flightId}?cabin=${flight.cabin || 'ECONOMY'}`);
    const pred = data.prediction;
    const el = document.getElementById(`pred-${flight.flightId}`);
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `
      <div class="prediction-bar">
        <span>${pred.icon}</span>
        <span>${pred.message}</span>
        <span style="margin-left:auto;font-weight:700;white-space:nowrap">${pred.recommendation}</span>
      </div>`;
  } catch (_) {}
}

function selectFlight(flightId) {
  selectedFlight = searchResults.find(f => f.flightId === flightId);
  if (!selectedFlight) return;

  // Visual selection
  document.querySelectorAll('.flight-card').forEach(el => el.classList.remove('selected'));
  document.getElementById(`fc-${flightId}`)?.classList.add('selected');

  if (!currentUser) {
    App.showAuthModal('login', () => navigate('booking', { flight: selectedFlight }));
    return;
  }
  navigate('booking', { flight: selectedFlight });
}

// ── Booking Page ───────────────────────────────────────────────
let bookingState = { step: 1, flight: null, booking: null, payment: null };

async function renderBooking(container, params) {
  bookingState.flight = params.flight;
  bookingState.step   = 1;

  container.innerHTML = `
    <div class="section" style="max-width:900px;margin:0 auto">
      <h2 class="section-title mb-24"><span>🎫</span>Book Your Flight</h2>
      ${stepWizard()}
      <div id="booking-step-content"></div>
    </div>`;

  renderBookingStep();
}

function stepWizard() {
  const steps = ['Passenger Details', 'Review & Confirm', 'Payment', 'Confirmation'];
  return `
    <div class="step-wizard">
      ${steps.map((s, i) => {
        const n = i + 1;
        const cls = n < bookingState.step ? 'done' : n === bookingState.step ? 'active' : '';
        return `<div class="step-item ${cls}">
          <div class="step-num">${n < bookingState.step ? '✓' : n}</div>
          ${s}
        </div>`;
      }).join('')}
    </div>`;
}

function renderBookingStep() {
  const content = $('booking-step-content');
  if (!content) return;
  // Update wizard
  const wizard = document.querySelector('.step-wizard');
  if (wizard) wizard.outerHTML = stepWizard();

  switch (bookingState.step) {
    case 1: content.innerHTML = bookingStepPassengers(); break;
    case 2: content.innerHTML = bookingStepReview(); break;
    case 3: content.innerHTML = bookingStepPayment(); break;
    case 4: content.innerHTML = bookingStepConfirmation(); break;
  }
}

function bookingStepPassengers() {
  const f = bookingState.flight;
  return `
    <div style="display:grid;grid-template-columns:1fr 360px;gap:24px">
      <div>
        <div class="card mb-16">
          <h3 class="mb-16">Passenger 1 — Adult</h3>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">First Name</label>
              <input class="form-control" id="pax-fname" placeholder="As on passport" value="${currentUser?.firstName || ''}" />
            </div>
            <div class="form-group">
              <label class="form-label">Last Name</label>
              <input class="form-control" id="pax-lname" placeholder="As on passport" value="${currentUser?.lastName || ''}" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Date of Birth</label>
              <input class="form-control" id="pax-dob" type="date" />
            </div>
            <div class="form-group">
              <label class="form-label">Nationality</label>
              <input class="form-control" id="pax-nat" placeholder="IN" maxlength="2" value="IN" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Passport No. (International)</label>
            <input class="form-control" id="pax-passport" placeholder="A1234567 (optional for domestic)" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Seat Preference</label>
              <select class="form-control" id="pax-seat">
                <option value="">No preference</option>
                <option value="WINDOW">Window</option>
                <option value="AISLE">Aisle</option>
                <option value="MIDDLE">Middle</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Meal Preference</label>
              <select class="form-control" id="pax-meal">
                <option value="VEG">Vegetarian</option>
                <option value="NON_VEG">Non-Vegetarian</option>
                <option value="VEGAN">Vegan</option>
                <option value="JAIN">Jain</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Coupon Code</label>
            <div class="flex gap-8">
              <input class="form-control" id="coupon-code" placeholder="FIRST10 · FLAT500 · WELCOME" />
              <button class="btn btn-secondary" onclick="applyCoupon()">Apply</button>
            </div>
            <div id="coupon-msg" class="form-hint"></div>
          </div>
        </div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="goToBookingStep2()">
          Continue → Review
        </button>
      </div>
      ${flightSummaryCard(f)}
    </div>`;
}

function flightSummaryCard(f) {
  if (!f) return '';
  return `
    <div>
      <div class="card" style="position:sticky;top:80px">
        <h4 class="mb-16">Flight Summary</h4>
        <div style="font-size:0.9rem">
          <div class="flex-between mb-8">
            <span class="text-muted">Flight</span>
            <span class="font-bold">${f.flightNumber}</span>
          </div>
          <div class="flex-between mb-8">
            <span class="text-muted">Route</span>
            <span>${f.origin} → ${f.destination}</span>
          </div>
          <div class="flex-between mb-8">
            <span class="text-muted">Date</span>
            <span>${formatDate(f.departure)}</span>
          </div>
          <div class="flex-between mb-8">
            <span class="text-muted">Time</span>
            <span>${f.departureTime} → ${f.arrivalTime}</span>
          </div>
          <div class="flex-between mb-8">
            <span class="text-muted">Cabin</span>
            <span>${f.cabin}</span>
          </div>
          <div class="flex-between mb-8">
            <span class="text-muted">Fare Basis</span>
            <span><span class="fare-badge">${f.fareBasis}</span></span>
          </div>
          <div class="divider"></div>
          <div class="flex-between">
            <span class="font-bold">Total</span>
            <span class="gradient-text font-bold" style="font-size:1.3rem">${formatINR(f.totalFare)}</span>
          </div>
          ${f.refundable ? '<div class="text-xs text-success mt-8">✓ Refundable</div>' : '<div class="text-xs text-muted mt-8">✗ Non-refundable</div>'}
        </div>
        <div class="divider"></div>
        <div style="font-size:0.78rem;color:var(--text-muted)">
          <div>⏱ Price locked for <span id="price-lock-countdown" style="color:var(--brand-warning)">10:00</span></div>
          <div class="mt-8">🔒 Secure booking. Idempotent payments.</div>
        </div>
      </div>
    </div>`;
}

function goToBookingStep2() {
  const fname = $('pax-fname')?.value?.trim();
  const lname = $('pax-lname')?.value?.trim();
  if (!fname || !lname) { toast('Please enter passenger name', 'warning'); return; }
  bookingState.passenger = {
    firstName: fname, lastName: lname,
    dob: $('pax-dob')?.value,
    nationality: $('pax-nat')?.value || 'IN',
    passportNo: $('pax-passport')?.value,
    seatPreference: $('pax-seat')?.value,
    meal: $('pax-meal')?.value,
    type: 'ADULT',
  };
  bookingState.coupon = $('coupon-code')?.value || null;
  bookingState.step = 2;
  renderBookingStep();
}

function bookingStepReview() {
  const f = bookingState.flight;
  const p = bookingState.passenger;
  return `
    <div style="display:grid;grid-template-columns:1fr 360px;gap:24px">
      <div>
        <div class="card mb-16">
          <h3 class="mb-20">Review Your Booking</h3>
          <div class="card" style="background:var(--bg-elevated);margin-bottom:16px">
            <div class="text-xs text-muted mb-8">PASSENGER</div>
            <div class="font-bold">${p.firstName} ${p.lastName}</div>
            <div class="text-sm text-muted">${p.nationality} · ${p.meal || 'VEG'} meal · ${p.seatPreference || 'Any seat'}</div>
          </div>
          <div class="card" style="background:var(--bg-elevated);margin-bottom:16px">
            <div class="text-xs text-muted mb-8">FLIGHT</div>
            <div class="font-bold">${f.flightNumber} — ${f.airline}</div>
            <div class="text-sm text-muted">${f.origin} → ${f.destination} · ${formatDate(f.departure)} · ${f.departureTime}</div>
            <div class="text-sm text-muted">${f.cabin} · ${f.fareBucketLabel || f.fareBasis}</div>
          </div>
          <div style="font-size:0.82rem;color:var(--text-muted);padding:12px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);border-radius:8px">
            ⚠️ <strong>Important:</strong> Please ensure passenger details match your government ID exactly.
            ${f.refundable ? ' This fare is refundable.' : ' This is a non-refundable fare.'}
          </div>
        </div>
        <div class="flex gap-12">
          <button class="btn btn-secondary" onclick="bookingState.step=1;renderBookingStep()">← Back</button>
          <button class="btn btn-primary btn-lg" style="flex:1" onclick="confirmBooking()">
            🔒 Confirm & Pay →
          </button>
        </div>
      </div>
      ${flightSummaryCard(f)}
    </div>`;
}

async function confirmBooking() {
  const f = bookingState.flight;
  const btn = document.querySelector('[onclick="confirmBooking()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating booking...'; }

  try {
    const body = {
      flightId: f.flightId,
      cabinClass: f.cabin,
      passengers: [bookingState.passenger],
      couponCode: bookingState.coupon,
      priceGuaranteeId: f.priceGuaranteeId,
    };
    const data = await apiFetch('/api/bookings', {
      method: 'POST', body, idempotent: true,
    });
    bookingState.booking = data;
    bookingState.step = 3;
    renderBookingStep();
    startHoldTimer(data.lockInfo?.expiresAt);
    toast(`Booking created! PNR: ${data.pnr}`, 'success');
  } catch (err) {
    const msg = err.data?.error === 'SEAT_LOCKED' ? 'Seats are being held by another booking. Please try again.' :
                err.data?.error === 'SOLD_OUT' ? 'Sorry, this flight is now full.' : err.message;
    toast(msg, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔒 Confirm & Pay →'; }
  }
}

function startHoldTimer(expiresAt) {
  if (!expiresAt) return;
  const updateTimer = () => {
    const remaining = Math.max(0, (new Date(expiresAt) - Date.now()) / 1000);
    const min = Math.floor(remaining / 60).toString().padStart(2,'0');
    const sec = Math.floor(remaining % 60).toString().padStart(2,'0');
    const el = $('price-lock-countdown');
    if (el) el.textContent = `${min}:${sec}`;
    if (remaining > 0) setTimeout(updateTimer, 1000);
    else if (el) { el.textContent = 'EXPIRED'; el.style.color = 'var(--brand-danger)'; }
  };
  updateTimer();
}

function bookingStepPayment() {
  const b = bookingState.booking;
  return `
    <div style="display:grid;grid-template-columns:1fr 360px;gap:24px">
      <div>
        <div class="card mb-16">
          <h3 class="mb-20">💳 Secure Payment</h3>
          <div class="card" style="background:rgba(16,185,129,0.05);border-color:rgba(16,185,129,0.2);margin-bottom:20px">
            <div class="text-sm" style="color:var(--brand-success)">✓ Booking held — PNR: <strong>${b?.pnr}</strong></div>
            <div class="text-xs text-muted mt-8">Complete payment within <span id="price-lock-countdown" style="color:var(--brand-warning)">10:00</span></div>
          </div>
          <div class="form-group">
            <label class="form-label">Payment Method</label>
            <div class="flex gap-8" style="flex-wrap:wrap">
              ${['💳 Credit/Debit Card','🏧 Net Banking','📱 UPI','💰 Wallet'].map((m,i) => `
                <button class="btn btn-secondary btn-sm ${i===0?'btn-primary':''}" onclick="selectPayMethod(this,'${m}')">${m}</button>`).join('')}
            </div>
          </div>
          <div id="card-fields">
            <div class="form-group">
              <label class="form-label">Card Number</label>
              <input class="form-control" placeholder="4242 4242 4242 4242" maxlength="19"
                     oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim()" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Expiry</label>
                <input class="form-control" placeholder="MM/YY" maxlength="5" />
              </div>
              <div class="form-group">
                <label class="form-label">CVV</label>
                <input class="form-control" placeholder="•••" maxlength="3" type="password" />
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.75rem;color:var(--text-muted);margin-bottom:20px">
            <span>🔒 256-bit SSL</span><span>·</span><span>🛡️ Fraud protected</span><span>·</span><span>💳 PCI-DSS compliant</span>
          </div>
        </div>
        <div class="flex gap-12">
          <button class="btn btn-secondary" onclick="bookingState.step=2;renderBookingStep()">← Back</button>
          <button class="btn btn-primary btn-lg" style="flex:1" id="pay-btn" onclick="processPayment()">
            Pay ${formatINR(b?.fare?.total || bookingState.flight?.totalFare || 0)} →
          </button>
        </div>
      </div>
      ${flightSummaryCard(bookingState.flight)}
    </div>`;
  startHoldTimer(bookingState.booking?.lockInfo?.expiresAt);
}

function selectPayMethod(btn, method) {
  document.querySelectorAll('[onclick^="selectPayMethod"]').forEach(b => {
    b.className = b.className.replace(' btn-primary','') + ' btn-secondary';
    b.className = b.className.replace('btn-secondary btn-secondary','btn-secondary');
  });
  btn.className = btn.className.replace('btn-secondary','btn-primary');
}

async function processPayment() {
  const btn = $('pay-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin">⟳</span> Processing...'; }

  try {
    const data = await apiFetch('/api/payments', {
      method: 'POST',
      body: { bookingId: bookingState.booking.bookingId, paymentMethod: 'CARD' },
      idempotent: true,
    });
    bookingState.payment = data;
    bookingState.step = 4;
    renderBookingStep();
    toast('Payment successful! 🎉', 'success');
  } catch (err) {
    const msg = err.data?.error === 'PAYMENT_FAILED' ? 'Payment declined. Please try another card.' :
                err.data?.error === 'BOOKING_EXPIRED' ? 'Your booking hold has expired. Please start over.' : err.message;
    toast(msg, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
  }
}

function bookingStepConfirmation() {
  const b = bookingState.booking;
  const p = bookingState.payment;
  const f = bookingState.flight;

  return `
    <div class="card text-center" style="padding:48px;max-width:600px;margin:0 auto">
      <div style="font-size:4rem;margin-bottom:16px;animation:float 2s ease-in-out infinite">🎉</div>
      <h2 class="gradient-text mb-16">Booking Confirmed!</h2>
      <div class="card" style="background:var(--bg-elevated);padding:24px;margin-bottom:24px">
        <div style="font-size:2rem;font-weight:900;letter-spacing:0.1em;color:var(--brand-primary);margin-bottom:8px">${b?.pnr}</div>
        <div class="text-sm text-muted">Your PNR (Booking Reference)</div>
      </div>
      <div style="text-align:left;font-size:0.875rem">
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <span class="text-muted">Flight</span><span class="font-bold">${f?.flightNumber} — ${f?.airline}</span>
        </div>
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <span class="text-muted">Route</span><span>${f?.origin} → ${f?.destination}</span>
        </div>
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <span class="text-muted">Date</span><span>${formatDate(f?.departure)}</span>
        </div>
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <span class="text-muted">Amount Paid</span>
          <span class="gradient-text font-bold">${formatINR(p?.totalCharged || bookingState.flight?.totalFare)}</span>
        </div>
        <div class="flex-between" style="padding:8px 0">
          <span class="text-muted">Points Earned</span>
          <span class="text-success font-bold">+${p?.pointsEarned || 0} pts 🌟</span>
        </div>
      </div>
      <div style="margin-top:28px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="navigate('dashboard')">📋 My Bookings</button>
        <button class="btn btn-secondary" onclick="navigate('home')">✈️ Book Another</button>
      </div>
      ${bookingState.booking?.bundleRecommendations?.length ? `
        <div style="margin-top:28px;text-align:left">
          <h4 class="mb-16">🎁 Add to Your Trip</h4>
          <div class="stats-grid">
            ${bookingState.booking.bundleRecommendations.map(b => `
              <div class="card" style="cursor:pointer;text-align:left" onclick="bundleAdd('${b.type}')">
                <div style="font-size:1.5rem">${b.icon}</div>
                <div class="font-bold text-sm mt-8">${b.title}</div>
                <div class="text-xs text-muted mt-4">${b.description}</div>
                <div class="gradient-text font-bold mt-8">${formatINR(b.price)}</div>
              </div>`).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

function bundleAdd(type) { toast(`${type} added to your trip!`, 'success'); }
function applyCoupon() {
  const code = $('coupon-code')?.value?.trim();
  if (code) {
    $('coupon-msg').textContent = `Coupon "${code}" will be applied at checkout`;
    $('coupon-msg').style.color = 'var(--brand-success)';
  }
}

// ── Dashboard (My Bookings) ────────────────────────────────────
async function renderDashboard(container) {
  if (!currentUser) { App.showAuthModal('login'); navigate('home'); return; }

  container.innerHTML = `
    <div class="section">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span>📋</span>My Bookings</h2>
          <p class="text-sm text-muted">Hello, ${currentUser.firstName}! Manage your trips.</p>
        </div>
        <div class="flex gap-12">
          <div class="card" style="padding:12px 20px;text-align:center;min-width:120px">
            <div class="stat-label">Loyalty Tier</div>
            <div class="loyalty-badge tier-${currentUser.loyaltyTier}" style="font-size:0.9rem;padding:4px 12px">${currentUser.loyaltyTier}</div>
          </div>
          <div class="card" style="padding:12px 20px;text-align:center;min-width:120px">
            <div class="stat-label">Points</div>
            <div class="gradient-text font-bold" style="font-size:1.2rem">${(currentUser.loyaltyPoints || 0).toLocaleString('en-IN')}</div>
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex gap-8 mb-24" style="flex-wrap:wrap">
        ${['ALL','CONFIRMED','HOLD','CANCELLED'].map(s => `
          <button class="btn btn-sm ${s==='ALL'?'btn-primary':'btn-secondary'}"
                  id="tab-${s}" onclick="filterBookings('${s}')">${s}</button>`).join('')}
        <div style="margin-left:auto">
          <input class="form-control" id="pnr-search" placeholder="Search by PNR..." style="width:200px"
                 onkeyup="if(event.key==='Enter')lookupPNR()" />
        </div>
      </div>

      <div id="bookings-list">
        ${[1,2,3].map(() => '<div class="skeleton skeleton-card mb-16"></div>').join('')}
      </div>

      <!-- Notifications -->
      <div class="mt-24">
        <h3 class="section-title mb-16"><span>🔔</span>Notifications</h3>
        <div id="notifications-list"><div class="skeleton skeleton-text"></div></div>
      </div>
    </div>`;

  await loadBookings('ALL');
  await loadNotifications();
}

async function loadBookings(status) {
  try {
    const qs = status !== 'ALL' ? `?status=${status}` : '';
    const data = await apiFetch(`/api/bookings${qs}`);
    const list = $('bookings-list');
    if (!list) return;

    if (!data.bookings?.length) {
      list.innerHTML = `
        <div class="card text-center" style="padding:40px">
          <div style="font-size:2rem;margin-bottom:12px">🎒</div>
          <h3>No bookings yet</h3>
          <button class="btn btn-primary mt-16" onclick="navigate('home')">Search Flights</button>
        </div>`;
      return;
    }

    list.innerHTML = data.bookings.map(b => `
      <div class="card mb-16" style="display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center">
        <div>
          <div class="flex gap-12 mb-8" style="align-items:center">
            <span class="font-bold" style="font-size:1.1rem">${b.pnr}</span>
            <span class="status-chip status-${b.status}">${b.status}</span>
          </div>
          ${b.flight ? `
            <div class="text-sm">✈️ <strong>${b.flight.flightNumber}</strong> — ${b.flight.origin} → ${b.flight.destination}</div>
            <div class="text-xs text-muted mt-4">${b.flight.departure ? formatDate(b.flight.departure) + ' ' + formatTime(b.flight.departure) : ''} · ${b.cabinClass}</div>
            ${b.flight?.status === 'DELAYED' ? '<div class="text-xs text-warning mt-4">⚠️ Flight Delayed</div>' : ''}
          ` : ''}
        </div>
        <div style="text-align:right">
          <div class="gradient-text font-bold" style="font-size:1.2rem">${formatINR(b.totalFare)}</div>
          <div class="text-xs text-muted mt-4">${formatDate(b.createdAt)}</div>
          ${b.status === 'CONFIRMED' ? `
            <button class="btn btn-danger btn-sm mt-8" onclick="cancelBooking('${b.bookingId}','${b.pnr}')">Cancel</button>` : ''}
          ${b.refundAmount ? `<div class="text-xs text-success mt-4">Refund: ${formatINR(b.refundAmount)}</div>` : ''}
        </div>
      </div>`).join('');
  } catch (err) {
    $('bookings-list').innerHTML = `<div class="card"><p class="text-danger">Failed to load bookings: ${err.message}</p></div>`;
  }
}

async function filterBookings(status) {
  ['ALL','CONFIRMED','HOLD','CANCELLED'].forEach(s => {
    const btn = $(`tab-${s}`);
    if (btn) btn.className = `btn btn-sm ${s===status?'btn-primary':'btn-secondary'}`;
  });
  await loadBookings(status);
}

async function cancelBooking(bookingId, pnr) {
  if (!confirm(`Cancel booking ${pnr}? This may incur cancellation fees.`)) return;
  try {
    const data = await apiFetch(`/api/bookings/${bookingId}`, { method: 'DELETE', body: { reason: 'PASSENGER_REQUEST' } });
    toast(`Booking ${pnr} cancelled. ${data.refundAmount ? `Refund: ${formatINR(data.refundAmount)}` : 'No refund eligible.'}`, 'info');
    await loadBookings('ALL');
  } catch (err) { toast(err.message, 'error'); }
}

async function lookupPNR() {
  const pnr = $('pnr-search')?.value?.trim().toUpperCase();
  if (!pnr) return;
  try {
    const data = await apiFetch(`/api/bookings/${pnr}`);
    toast(`Found: PNR ${data.pnr} — ${data.status}`, 'info');
  } catch (_) { toast('PNR not found', 'error'); }
}

async function loadNotifications() {
  try {
    const data = await apiFetch('/api/analytics/notifications');
    const el = $('notifications-list');
    if (!el) return;
    if (!data.notifications?.length) {
      el.innerHTML = '<p class="text-muted text-sm">No notifications</p>';
      return;
    }
    el.innerHTML = data.notifications.slice(0, 5).map(n => `
      <div class="card mb-8" style="padding:12px 16px;display:flex;gap:12px;align-items:start">
        <span>${n.type === 'BOOKING_CONFIRMED' ? '✅' : n.type === 'FLIGHT_DELAYED' ? '⚠️' : n.type === 'REBOOKED' ? '🔄' : '📢'}</span>
        <div>
          <div class="text-sm font-bold">${n.subject}</div>
          <div class="text-xs text-muted mt-4">${n.body}</div>
          <div class="text-xs text-muted mt-4">${formatDate(n.created_at)}</div>
        </div>
      </div>`).join('');
  } catch (_) {}
}

// ── Analytics Dashboard ────────────────────────────────────────
async function renderAnalytics(container) {
  if (currentUser?.role !== 'admin') { toast('Admin access required', 'error'); navigate('home'); return; }

  container.innerHTML = `
    <div class="section">
      <div class="section-header">
        <h2 class="section-title"><span>📊</span>Revenue Analytics</h2>
        <button class="btn btn-ghost btn-sm" onclick="renderAnalytics($('page-container'))">↻ Refresh</button>
      </div>
      <div id="analytics-kpis"><div class="stats-grid">${[1,2,3,4,5,6].map(()=>'<div class="skeleton skeleton-card"></div>').join('')}</div></div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-top:24px">
        <div class="card" id="chart-daily">
          <h3 class="mb-16">Daily Revenue (Last 14 Days)</h3>
          <div id="daily-chart">Loading...</div>
        </div>
        <div class="card" id="cabin-breakdown">
          <h3 class="mb-16">Revenue by Class</h3>
          <div id="cabin-chart">Loading...</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px">
        <div class="card">
          <h3 class="mb-16">🔥 Top Routes</h3>
          <div id="top-routes">Loading...</div>
        </div>
        <div class="card">
          <h3 class="mb-16">⚡ Event Bus Metrics</h3>
          <div id="event-metrics">Loading...</div>
        </div>
      </div>
    </div>`;

  try {
    const [rev, evts, cache, anomalies] = await Promise.all([
      apiFetch('/api/analytics/revenue'),
      apiFetch('/api/analytics/events'),
      apiFetch('/api/analytics/cache'),
      apiFetch('/api/analytics/anomalies'),
    ]);

    const k = rev.kpis;
    $('analytics-kpis').innerHTML = `<div class="stats-grid">
      ${[
        { label:'Total Revenue', value: formatINR(k.totalRevenue), change:'+12.3%', up:true },
        { label:'Total Bookings', value: k.totalBookings.toLocaleString(), change:'+8.1%', up:true },
        { label:'Avg Booking Value', value: formatINR(k.avgBookingValue), change:'+4.2%', up:true },
        { label:'Avg Load Factor', value: k.avgLoadFactor.toFixed(1)+'%', change:'+2.8%', up:true },
        { label:'Cancellation Rate', value: k.cancellationRate+'%', change:'-0.5%', up:false },
        { label:'Active Flights', value: k.activeFlights.toLocaleString(), change:'', up:true },
      ].map(s => `
        <div class="stat-card">
          <div class="stat-label">${s.label}</div>
          <div class="stat-value gradient-text">${s.value}</div>
          ${s.change ? `<div class="stat-change ${s.up?'stat-up':'stat-down'}">${s.up?'▲':'▼'} ${s.change}</div>` : ''}
        </div>`).join('')}
    </div>`;

    // Daily chart
    const maxRev = Math.max(...rev.dailyRevenue.map(d => d.revenue), 1);
    $('daily-chart').innerHTML = `<div class="chart-bars">
      ${rev.dailyRevenue.map(d => `
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="height:${Math.max(4,(d.revenue/maxRev)*100)}%"
               title="${d.date}: ${formatINR(d.revenue)}"></div>
          <div class="chart-label">${d.date.slice(5)}</div>
        </div>`).join('')}
    </div>`;

    // Cabin breakdown
    $('cabin-chart').innerHTML = rev.revenueByClass.map(c => `
      <div style="margin-bottom:16px">
        <div class="flex-between text-sm mb-4">
          <span>${c.cabin}</span>
          <span class="font-bold">${c.percentage}% · ${formatINR(c.revenue)}</span>
        </div>
        <div class="fare-meter"><div class="fare-meter-fill" style="width:${c.percentage}%"></div></div>
      </div>`).join('');

    // Top routes
    $('top-routes').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Route</th><th>Revenue</th></tr></thead><tbody>
      ${rev.topRoutes.map(r => `<tr><td class="td-primary">${r.route}</td><td>${formatINR(r.revenue)}</td></tr>`).join('')}
    </tbody></table></div>`;

    // Event metrics
    $('event-metrics').innerHTML = `
      <div class="flex-between text-sm mb-8"><span class="text-muted">Total Events</span><span class="font-bold">${evts.totalEvents}</span></div>
      <div class="flex-between text-sm mb-8"><span class="text-muted">DLQ Size</span><span class="${evts.dlqSize>0?'text-warning':'font-bold'}">${evts.dlqSize}</span></div>
      ${Object.entries(evts.byTopic || {}).map(([t,c]) => `
        <div class="flex-between text-sm mb-4"><span class="text-muted">${t}</span><span>${c}</span></div>`).join('')}
      <div class="divider"></div>
      <div class="flex-between text-sm mb-8"><span class="text-muted">Cache Hit Rate</span><span class="text-success font-bold">${cache.hitRate}</span></div>
      <div class="flex-between text-sm"><span class="text-muted">Cache Size</span><span>${cache.size}</span></div>
      <div class="divider"></div>
      <div class="text-sm font-bold mb-8">Recent Anomalies</div>
      ${anomalies.anomalies.slice(0,3).map(a => `
        <div style="font-size:0.75rem;padding:6px;background:rgba(239,68,68,0.05);border-radius:6px;margin-bottom:4px">
          <span class="text-warning">⚠️</span> ${a.route} — z=${a.zScore} (${a.severity})
        </div>`).join('') || '<p class="text-xs text-muted">No anomalies detected</p>'}`;
  } catch (err) {
    toast('Failed to load analytics: ' + err.message, 'error');
  }
}

// ── Admin Panel ─────────────────────────────────────────────────
async function renderAdmin(container) {
  if (currentUser?.role !== 'admin') { navigate('home'); return; }

  container.innerHTML = `
    <div class="section">
      <h2 class="section-title mb-24"><span>⚙️</span>Admin Control Panel</h2>
      <div class="admin-grid">
        <div class="admin-sidebar">
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;padding:8px 16px;margin-bottom:4px">Operations</div>
          ${[
            { id:'ops-delay',   icon:'⏰', label:'Trigger Delay' },
            { id:'ops-cancel',  icon:'❌', label:'Cancel Flight' },
            { id:'ops-sim',     icon:'🎭', label:'Run Simulation' },
            { id:'ops-events',  icon:'📜', label:'Event Log' },
            { id:'ops-users',   icon:'👥', label:'Users' },
          ].map(item => `
            <button class="admin-nav-item" id="${item.id}" onclick="adminSection('${item.id}')">
              <span>${item.icon}</span>${item.label}
            </button>`).join('')}
        </div>
        <div id="admin-content">
          <div class="card text-center" style="padding:40px">
            <div style="font-size:2.5rem;margin-bottom:16px">⚙️</div>
            <h3>Select an operation</h3>
            <p class="text-muted">Use the left panel to manage flights and operations</p>
          </div>
        </div>
      </div>
    </div>`;
}

function adminSection(id) {
  document.querySelectorAll('.admin-nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');

  const content = $('admin-content');
  if (!content) return;

  if (id === 'ops-delay')  content.innerHTML = adminDelayForm();
  if (id === 'ops-cancel') content.innerHTML = adminCancelForm();
  if (id === 'ops-sim')    content.innerHTML = adminSimForm();
  if (id === 'ops-events') loadOpsEvents(content);
  if (id === 'ops-users')  loadUsers(content);
}

function adminDelayForm() {
  const flights = (window._db_flights || []).slice(0, 20);
  return `
    <div class="card">
      <h3 class="mb-20">⏰ Trigger Flight Delay</h3>
      <div class="form-group">
        <label class="form-label">Flight ID</label>
        <input class="form-control" id="adm-flightId" placeholder="Paste flight UUID" />
      </div>
      <div class="form-group">
        <label class="form-label">Delay (minutes)</label>
        <input class="form-control" id="adm-delay" type="number" placeholder="e.g. 120" value="90" />
      </div>
      <div class="form-group">
        <label class="form-label">Reason</label>
        <select class="form-control" id="adm-reason">
          <option value="WEATHER">Weather</option>
          <option value="TECHNICAL">Technical</option>
          <option value="ATC">ATC Congestion</option>
          <option value="OPERATIONAL">Operational</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="triggerDelay()">⏰ Trigger Delay</button>
      <div id="delay-result" class="mt-16"></div>
    </div>`;
}

async function triggerDelay() {
  const flightId = $('adm-flightId')?.value?.trim();
  const delay = parseInt($('adm-delay')?.value || 0);
  const reason = $('adm-reason')?.value;
  if (!flightId) { toast('Enter a flight ID', 'warning'); return; }
  try {
    const data = await apiFetch('/api/operations/delay', { method:'POST', body:{ flightId, delayMinutes: delay, reason } });
    $('delay-result').innerHTML = `
      <div class="card" style="background:rgba(245,158,11,0.05);border-color:rgba(245,158,11,0.2)">
        <div class="text-warning font-bold">Delay triggered successfully</div>
        <div class="text-sm mt-8">Affected bookings: ${data.affectedBookings}</div>
        <div class="text-sm">Auto-rebooked: ${data.autoRebookingEligible}</div>
        <div class="text-sm">Notifications queued: ${data.notificationsQueued}</div>
        ${data.compensationEligible ? `<div class="text-sm text-success mt-4">✓ Compensation eligible</div>` : ''}
      </div>`;
    toast('Delay triggered, passengers notified', 'warning');
  } catch (err) { toast(err.message, 'error'); }
}

function adminCancelForm() {
  return `
    <div class="card">
      <h3 class="mb-20">❌ Cancel Flight</h3>
      <div class="form-group">
        <label class="form-label">Flight ID</label>
        <input class="form-control" id="adm-cancel-flightId" placeholder="Flight UUID" />
      </div>
      <div class="form-group">
        <label class="form-label">Reason</label>
        <input class="form-control" id="adm-cancel-reason" placeholder="Reason for cancellation" value="Technical issues" />
      </div>
      <button class="btn btn-danger" onclick="triggerCancel()">❌ Cancel Flight</button>
    </div>`;
}

async function triggerCancel() {
  const flightId = $('adm-cancel-flightId')?.value?.trim();
  const reason = $('adm-cancel-reason')?.value;
  if (!flightId) { toast('Enter flight ID', 'warning'); return; }
  try {
    const data = await apiFetch('/api/operations/cancel', { method:'POST', body:{ flightId, reason } });
    toast(`Flight cancelled. ${data.affectedBookings} bookings auto-refunded.`, 'warning');
  } catch (err) { toast(err.message, 'error'); }
}

function adminSimForm() {
  return `
    <div class="card">
      <h3 class="mb-20">🎭 Run Random Simulation</h3>
      <p class="text-muted mb-20">Trigger a random operational event (delay, gate change, etc.) on an active flight. Used for demo and chaos engineering.</p>
      <button class="btn btn-primary" id="sim-btn" onclick="runSimulation()">🎭 Simulate Event</button>
      <div id="sim-result" class="mt-16"></div>
    </div>`;
}

async function runSimulation() {
  const btn = $('sim-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }
  try {
    const data = await apiFetch('/api/operations/simulate', { method: 'POST', body: {} });
    $('sim-result').innerHTML = `
      <div class="card" style="background:rgba(99,102,241,0.05)">
        <pre style="font-size:0.78rem;color:var(--text-secondary);white-space:pre-wrap">${JSON.stringify(data, null, 2)}</pre>
      </div>`;
    toast('Simulation event fired!', 'info');
  } catch (err) { toast(err.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🎭 Simulate Event'; } }
}

async function loadOpsEvents(container) {
  try {
    const data = await apiFetch('/api/operations/events');
    container.innerHTML = `
      <div class="card">
        <h3 class="mb-16">📜 Operations Event Log</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Event</th><th>Flight</th><th>Delay</th><th>Reason</th><th>Affected</th><th>When</th></tr></thead>
            <tbody>
              ${data.events.map(e => `
                <tr>
                  <td><span class="status-chip status-${e.event_type === 'DELAYED' ? 'DELAYED' : 'CANCELLED'}">${e.event_type}</span></td>
                  <td class="td-primary">${e.flight_id?.slice(0,8)}...</td>
                  <td>${e.delay_minutes ? `+${e.delay_minutes}m` : '—'}</td>
                  <td>${e.reason || '—'}</td>
                  <td>${e.affected_pax_count}</td>
                  <td class="text-muted">${formatDate(e.created_at)}</td>
                </tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted">No events yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (err) { container.innerHTML = `<div class="card"><p class="text-danger">${err.message}</p></div>`; }
}

async function loadUsers(container) {
  container.innerHTML = `
    <div class="card">
      <h3 class="mb-16">👥 Users</h3>
      <p class="text-muted">Login: <strong>ankit@skyplatform.in</strong> / <strong>admin123</strong> (admin)</p>
      <p class="text-muted mt-8">Login: <strong>priya@example.com</strong> / <strong>pass123</strong> (passenger)</p>
      <p class="text-muted mt-8">Login: <strong>rahul@example.com</strong> / <strong>pass123</strong> (passenger)</p>
    </div>`;
}

// ── Live Board ─────────────────────────────────────────────────
async function renderLiveBoard(container) {
  container.innerHTML = `
    <div class="section">
      <div class="section-header">
        <h2 class="section-title"><span class="live-dot"></span>Live Flight Board</h2>
        <div class="flex gap-12">
          <span class="text-sm text-muted">Auto refreshes every 30s</span>
          <button class="btn btn-ghost btn-sm" onclick="renderLiveBoard($('page-container'))">↻ Refresh</button>
        </div>
      </div>
      <div class="card mb-20" id="ops-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px">
        <div class="text-center"><div class="stat-label">Total Flights</div><div id="live-total" class="stat-value">—</div></div>
        <div class="text-center"><div class="stat-label">On Time</div><div id="live-ontime" class="stat-value text-success">—</div></div>
        <div class="text-center"><div class="stat-label">Delayed</div><div id="live-delayed" class="stat-value text-warning">—</div></div>
        <div class="text-center"><div class="stat-label">Cancelled</div><div id="live-cancelled" class="stat-value text-danger">—</div></div>
      </div>
      <div id="live-board">
        ${[1,2,3,4,5].map(()=>'<div class="skeleton skeleton-flight mb-8"></div>').join('')}
      </div>
    </div>`;

  await fetchLiveBoard();
  setInterval(() => {
    if (currentRoute === 'live') fetchLiveBoard();
  }, 30000);
}

async function fetchLiveBoard() {
  try {
    const data = await apiFetch('/api/operations/live');
    const flights = data.flights || [];

    if ($('live-total')) $('live-total').textContent = flights.length;
    if ($('live-ontime')) $('live-ontime').textContent = flights.filter(f=>f.status==='SCHEDULED').length;
    if ($('live-delayed')) $('live-delayed').textContent = flights.filter(f=>f.status==='DELAYED').length;
    if ($('live-cancelled')) $('live-cancelled').textContent = flights.filter(f=>f.status==='CANCELLED').length;

    const board = $('live-board');
    if (!board) return;
    if (!flights.length) {
      board.innerHTML = `<div class="card text-center" style="padding:40px"><p class="text-muted">No active flights in the next 6 hours</p></div>`;
      return;
    }
    board.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Flight</th><th>Airline</th><th>Route</th><th>Scheduled</th>
            <th>Estimated</th><th>Status</th><th>Delay</th>
          </tr></thead>
          <tbody>
            ${flights.map(f => `
              <tr class="live-row">
                <td class="td-primary">${f.flightNumber}</td>
                <td>${f.airlineLogo || '✈️'} ${f.airline || ''}</td>
                <td>${f.origin} <span style="color:var(--brand-primary)">→</span> ${f.destination}</td>
                <td>${formatTime(f.scheduledDeparture)}</td>
                <td>${formatTime(f.estimatedDeparture)}</td>
                <td><span class="status-chip status-${f.status}">${f.status}</span></td>
                <td>${f.delayMinutes > 0 ? `<span class="delay-badge">+${f.delayMinutes}m</span>` : '<span style="color:var(--brand-success);font-size:0.78rem">On time</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) { console.error('Live board error:', err); }
}

// ── Auth Modal ─────────────────────────────────────────────────
function showAuthModal(mode = 'login', callback = null) {
  closeModal();
  const isLogin = mode === 'login';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'auth-modal';
  overlay.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2 class="modal-title">${isLogin ? '👋 Sign In' : '✨ Create Account'}</h2>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      ${isLogin ? loginForm() : registerForm()}
    </div>`;
  overlay.addEventListener('click', closeModal);
  document.body.appendChild(overlay);

  if (isLogin) {
    document.getElementById('login-btn')?.addEventListener('click', () => doLogin(callback));
    document.getElementById('login-email')?.addEventListener('keyup', e => { if (e.key==='Enter') doLogin(callback); });
  } else {
    document.getElementById('reg-btn')?.addEventListener('click', doRegister);
  }
}

function loginForm() {
  return `
    <div class="form-group">
      <label class="form-label">Email</label>
      <input class="form-control" id="login-email" type="email" placeholder="ankit@skyplatform.in" value="ankit@skyplatform.in" />
    </div>
    <div class="form-group">
      <label class="form-label">Password</label>
      <input class="form-control" id="login-pass" type="password" placeholder="••••••" value="admin123" />
    </div>
    <button class="btn btn-primary" style="width:100%" id="login-btn">Sign In →</button>
    <div class="text-center mt-16 text-sm text-muted">
      No account? <a style="color:var(--brand-primary);cursor:pointer" onclick="showAuthModal('register')">Create one free</a>
    </div>
    <div class="divider"></div>
    <div class="text-xs text-muted text-center">
      Demo Admin: ankit@skyplatform.in / admin123<br/>
      Demo User: priya@example.com / pass123
    </div>`;
}

function registerForm() {
  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">First Name</label>
        <input class="form-control" id="reg-fname" placeholder="Priya" />
      </div>
      <div class="form-group">
        <label class="form-label">Last Name</label>
        <input class="form-control" id="reg-lname" placeholder="Sharma" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Email</label>
      <input class="form-control" id="reg-email" type="email" placeholder="you@email.com" />
    </div>
    <div class="form-group">
      <label class="form-label">Password</label>
      <input class="form-control" id="reg-pass" type="password" placeholder="minimum 6 characters" />
    </div>
    <button class="btn btn-primary" style="width:100%" id="reg-btn">Create Account + 500 pts 🌟</button>
    <div class="text-center mt-16 text-sm text-muted">
      Have an account? <a style="color:var(--brand-primary);cursor:pointer" onclick="showAuthModal('login')">Sign in</a>
    </div>`;
}

async function doLogin(callback) {
  const email = $('login-email')?.value; const pass = $('login-pass')?.value;
  const btn = $('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  try {
    const data = await apiFetch('/api/auth/login', { method:'POST', body:{ email, password: pass } });
    saveAuth(data.accessToken, data.user, data.expiresIn);
    closeModal();
    toast(`Welcome back, ${data.user.firstName}! 🎉`, 'success');
    renderNav();
    if (callback) callback();
    else navigate(currentRoute);
  } catch (err) {
    toast(err.data?.error === 'INVALID_CREDENTIALS' ? 'Invalid email or password' : err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In →'; }
  }
}

async function doRegister() {
  const email = $('reg-email')?.value; const pass = $('reg-pass')?.value;
  const firstName = $('reg-fname')?.value; const lastName = $('reg-lname')?.value;
  const btn = $('reg-btn');
  if (!email || !pass || !firstName) { toast('Please fill all fields', 'warning'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
  try {
    await apiFetch('/api/auth/register', { method:'POST', body:{ email, password: pass, firstName, lastName } });
    toast('Account created! Signing you in...', 'success');
    // Auto-login
    $('login-email') ? ($('login-email').value = email) : null;
    $('login-pass')  ? ($('login-pass').value  = pass)  : null;
    showAuthModal('login');
  } catch (err) {
    toast(err.data?.error === 'EMAIL_ALREADY_EXISTS' ? 'Email already registered' : err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
  }
}

function closeModal() {
  $('auth-modal')?.remove();
}

// ── Chatbot ────────────────────────────────────────────────────
let chatOpen = false;
let chatMessages = [];

function toggleChatbot() {
  chatOpen = !chatOpen;
  const panel = $('chatbot-panel');
  const badge = $('chatbot-badge');
  if (panel) panel.style.display = chatOpen ? 'flex' : 'none';
  if (badge) badge.style.display = 'none';

  if (chatOpen && chatMessages.length === 0) {
    addBotMessage('👋 Hi! I\'m SkyAI. I can help you search flights, check your booking, predict fares, and more.');
    loadChatSuggestions();
  }
}

function addBotMessage(text) {
  chatMessages.push({ role: 'bot', text });
  renderChatMessages();
}

function addUserMessage(text) {
  chatMessages.push({ role: 'user', text });
  renderChatMessages();
}

function renderChatMessages() {
  const el = $('chatbot-messages');
  if (!el) return;
  el.innerHTML = chatMessages.map(m => `
    <div class="chat-msg ${m.role}">${m.text.replace(/\n/g,'<br/>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')}</div>
  `).join('');
  el.scrollTop = el.scrollHeight;
}

async function loadChatSuggestions() {
  try {
    const data = await apiFetch('/api/chatbot/suggestions');
    const el = $('chatbot-suggestions');
    if (!el) return;
    el.innerHTML = data.suggestions.map(s => `
      <button class="chat-suggestion" onclick="sendSuggestion('${s.replace(/'/g, "\\'")}')">${s}</button>
    `).join('');
  } catch (_) {}
}

function sendSuggestion(text) {
  const input = $('chatbot-input');
  if (input) input.value = text;
  sendChatMessage();
}

async function sendChatMessage() {
  const input = $('chatbot-input');
  const msg = input?.value?.trim();
  if (!msg) return;
  input.value = '';

  addUserMessage(msg);
  $('chatbot-suggestions').innerHTML = '';

  // Typing indicator
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-msg bot';
  typingEl.id = 'typing';
  typingEl.innerHTML = '⟳ Thinking...';
  typingEl.style.animation = 'none';
  $('chatbot-messages')?.appendChild(typingEl);

  try {
    const data = await apiFetch('/api/chatbot/message', {
      method: 'POST',
      body: { message: msg, context: { userId: currentUser?.userId } },
    });
    typingEl.remove();
    addBotMessage(data.response);
    if (data.actions?.length) {
      data.actions.forEach(action => {
        if (action.type === 'SEARCH_LINK') {
          setTimeout(() => {
            quickSearch(action.origin, action.dest);
            if (chatOpen) toggleChatbot();
          }, 1200);
        }
      });
    }
  } catch (_) {
    typingEl.remove();
    addBotMessage('Sorry, I\'m having trouble right now. Please try again.');
  }
}

// Enter key for chatbot
document.addEventListener('keyup', (e) => {
  if (e.key === 'Enter' && document.activeElement?.id === 'chatbot-input') {
    sendChatMessage();
  }
});

// ── WebSocket ──────────────────────────────────────────────────
function initWebSocket() {
  try {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('[WS] Connected');
      if (currentUser) socket.emit('subscribe:user', currentUser.userId);
    });

    socket.on('operations:update', (event) => {
      if (event.type === 'flight_delayed' || event.type === 'flight_cancelled') {
        const delay = event.payload?.delayMinutes;
        const fNum = event.payload?.flightNumber || 'Flight';
        toast(`${event.type === 'flight_delayed' ? '⚠️' : '❌'} ${fNum} ${event.type === 'flight_delayed' ? `delayed +${delay}m` : 'cancelled'}`, event.type === 'flight_delayed' ? 'warning' : 'error', 6000);
      }
    });

    socket.on('booking:update', (event) => {
      if (event.type === 'booking_confirmed') {
        toast(`✅ Booking confirmed — PNR: ${event.pnr}`, 'success');
      }
    });

    socket.on('inventory:update', (event) => {
      if (event.payload?.alertLevel === 'CRITICAL') {
        // Invalidate search cache silently
      }
    });
  } catch (err) {
    console.warn('[WS] WebSocket unavailable, running without real-time updates');
  }
}

// ── Global App Object ──────────────────────────────────────────
const App = {
  showAuthModal,
  toggleChatbot,
  sendChatMessage,
  logout: async () => {
    try {
      if (authToken) await apiFetch('/api/auth/logout', { method:'POST', body:{} });
    } catch (_) {}
    clearAuth();
    renderNav();
    toast('Logged out successfully', 'info');
    navigate('home');
  },
};

// ── Bootstrap ──────────────────────────────────────────────────
window.App = App;
window.navigate = navigate;
window.doSearch = doSearch;
window.quickSearch = quickSearch;
window.swapAirports = swapAirports;
window.sortResults = sortResults;
window.selectFlight = selectFlight;
window.goToBookingStep2 = goToBookingStep2;
window.applyCoupon = applyCoupon;
window.confirmBooking = confirmBooking;
window.processPayment = processPayment;
window.selectPayMethod = selectPayMethod;
window.bundleAdd = bundleAdd;
window.filterBookings = filterBookings;
window.cancelBooking = cancelBooking;
window.lookupPNR = lookupPNR;
window.adminSection = adminSection;
window.triggerDelay = triggerDelay;
window.triggerCancel = triggerCancel;
window.runSimulation = runSimulation;
window.closeModal = closeModal;
window.sendSuggestion = sendSuggestion;

window.addEventListener('DOMContentLoaded', () => {
  // Set today as default date
  const dateInput = document.getElementById ? document.getElementById('s-date') : null;

  // Load auth
  loadAuth();

  // Build page container
  const splash = $('splash');
  setTimeout(() => {
    // Hide splash
    splash?.classList.add('hidden');

    // Create page container
    let pc = $('page-container');
    if (!pc) {
      pc = document.createElement('div');
      pc.id = 'page-container';
      document.body.appendChild(pc);
    }

    // Render nav
    renderNav();

    // Navigate to home
    navigate('home');

    // Set default date
    const sDate = $('s-date');
    if (sDate) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      sDate.value = tomorrow.toISOString().split('T')[0];
      sDate.min = new Date().toISOString().split('T')[0];
    }

    // Init WebSocket
    initWebSocket();
  }, 2200);
});
