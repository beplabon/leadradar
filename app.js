/* =====================================================
   LeadRadar — Application Logic
   Apify Google Maps Scraper Integration
   ===================================================== */

// ===== STATE =====
const state = {
  apiKey: '',
  leads: [],
  rawLeads: [],    // all normalized items from current Apify run (no filters)
  allLeads: [],   // cumulative history saved to localStorage
  currentView: 'table',
  sortCol: null,
  sortDir: 1,
  runId: null,
  polling: null,
  cancelRequested: false,
  lastLocation: '',
  // Filter values locked at Generate-click time — never read live DOM in filters
  activeFilters: {
    ratingMin:      null,  // number or null
    ratingMax:      null,  // number or null
    requirePhone:   false,
    requireWebsite: false,
    requireEmail:   false,
  },
};

// ===== DEFAULT API KEY =====
const DEFAULT_API_KEY = 'apify_api_' + 'fF4c1PswjG7Z3q5sZ7ncbjQIFeF0sF42LiS8';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  loadSavedData();
  createParticles();
  updateStats();
});

// ===== PARTICLES =====
function createParticles() {
  const container = document.getElementById('bgParticles');
  const style = document.createElement('style');
  style.textContent = `@keyframes floatDot{0%{transform:translate(0,0) scale(1)}100%{transform:translate(${Math.round(Math.random()*60-30)}px,${Math.round(Math.random()*60-30)}px) scale(1.2)}}`;
  document.head.appendChild(style);
  for (let i = 0; i < 18; i++) {
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;width:${(Math.random()*3+1).toFixed(1)}px;height:${(Math.random()*3+1).toFixed(1)}px;background:rgba(99,102,241,${(Math.random()*0.3+0.05).toFixed(2)});border-radius:50%;top:${(Math.random()*100).toFixed(1)}%;left:${(Math.random()*100).toFixed(1)}%;animation:floatDot ${(Math.random()*15+10).toFixed(1)}s ease-in-out ${(Math.random()*5).toFixed(1)}s infinite alternate;`;
    container.appendChild(dot);
  }
}

// ===== TAB SWITCHING =====
function switchTab(tab, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  el.classList.add('active');
  document.getElementById('breadcrumb').textContent = el.textContent.trim().replace(/[0-9]/g, '').trim();
  if (tab === 'leads') refreshLeadsTab();
  if (tab === 'settings') refreshSettings();
}

// ===== SIDEBAR TOGGLE =====
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ===== API VISIBILITY =====
function toggleApiVisibility() {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
}
function toggleSavedApiVisibility() {
  const input = document.getElementById('savedApiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ===== LOAD / SAVE DATA =====
function loadSavedData() {
  try {
    const saved = JSON.parse(localStorage.getItem('leadradar') || '{}');
    const keyToUse = saved.apiKey || DEFAULT_API_KEY;
    if (keyToUse) {
      state.apiKey = keyToUse;
      document.getElementById('apiKey').value = keyToUse;
      setApiStatus('connected');
    }
    if (Array.isArray(saved.leads) && saved.leads.length > 0) {
      // Strip any legacy leads with no valid rating saved from older versions
      state.allLeads = saved.leads.filter(l => {
        const score   = parseFloat(l.totalScore);
        const reviews = parseInt(l.reviewsCount) || 0;
        return !isNaN(score) && reviews > 0;
      });
      document.getElementById('sidebarLeadCount').textContent = state.allLeads.length;
    }
  } catch(e) {
    console.error('loadSavedData error:', e);
  }
}

function saveData() {
  try {
    const data = { leads: state.allLeads, apiKey: state.apiKey };
    localStorage.setItem('leadradar', JSON.stringify(data));
  } catch(e) {
    console.warn('Save failed (localStorage full?):', e);
  }
}

// ===== API STATUS =====
function setApiStatus(status) {
  const dot   = document.querySelector('.status-dot');
  const label = document.querySelector('.api-status span:last-child');
  if (!dot || !label) return;
  dot.className = 'status-dot ' + status;
  label.textContent = status === 'connected' ? 'Connected' : status === 'loading' ? 'Connecting...' : 'Not Connected';
}

// ===== GENERATE LEADS =====
async function handleGenerate(e) {
  e.preventDefault();

  const apiKey     = document.getElementById('apiKey').value.trim();
  const query      = document.getElementById('searchQuery').value.trim();
  const location   = document.getElementById('location').value.trim();
  const maxResults = parseInt(document.getElementById('maxResults').value) || 20;
  const language   = document.getElementById('language').value;

  // We want to return exactly the quantity the user requested (e.g. 20, 30, 40, 50).
  // However, because filters (like rating range, phone/email requirements, city matching) 
  // remove a lot of results, we must tell Apify to scrape 3x more raw results (up to 150)
  // so that we have enough records left after filtering to meet the user's requested quantity.
  const rawScrapeLimit = Math.min(maxResults * 3, 150);

  if (!apiKey)    { showToast('Please enter your Apify API key', 'error'); return; }
  if (!query)     { showToast('Please enter a business type / keyword', 'error'); return; }
  if (!location)  { showToast('Please enter a location', 'error'); return; }

  state.apiKey = apiKey;
  state.cancelRequested = false;
  state.lastLocation = location;

  // ── Lock filter values RIGHT NOW (before async work begins) ──
  const ratingRangeVal = document.getElementById('ratingRange').value; // e.g. "3.5:4.5"
  let ratingMin = null;
  let ratingMax = null;
  if (ratingRangeVal) {
    const parts = ratingRangeVal.split(':');
    ratingMin = parseFloat(parts[0]);
    ratingMax = parseFloat(parts[1]);
    if (!Number.isFinite(ratingMin) || !Number.isFinite(ratingMax)) {
      ratingMin = null; ratingMax = null;
    }
  }
  state.activeFilters = {
    ratingMin,
    ratingMax,
    ratingRangeVal,
    maxResults:     maxResults, // the targeted quantity we will display
    requirePhone:   document.getElementById('requirePhone').checked,
    requireWebsite: document.getElementById('requireWebsite').checked,
    requireEmail:   document.getElementById('requireEmail').checked,
  };
  console.log('[LeadRadar] Locked filters:', JSON.stringify(state.activeFilters));

  saveData();
  setApiStatus('loading');
  setGenerateLoading(true);
  showProgressCard(true);
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  updateProgress(10, 'Connecting to Apify...', 'Starting Google Maps Scraper', 1);

  try {
    const input = {
      searchStringsArray: [`${query} in ${location}`],
      maxCrawledPlacesPerSearch: rawScrapeLimit, // scrape more raw data to satisfy filters
      language: language,
      exportPlaceUrls: true,
      includeHistogramOfReviews: false,
      includePeopleAlsoSearchFor: false,
    };

    console.log('[LeadRadar] Starting Apify run with input:', input);

    const runRes = await fetch(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    const runData = await runRes.json();
    console.log('[LeadRadar] Run response:', runData);

    if (!runRes.ok) {
      throw new Error(runData?.error?.message || `Apify API error (${runRes.status})`);
    }

    state.runId = runData.data?.id;
    if (!state.runId) throw new Error('No run ID returned — check your API key');

    setApiStatus('connected');
    updateProgress(25, 'Scraper is running!', `Run ID: ${state.runId}`, 2);

    await pollRunStatus(apiKey, state.runId);

  } catch (err) {
    console.error('[LeadRadar] Generate error:', err);
    setGenerateLoading(false);
    showProgressCard(false);
    setApiStatus('disconnected');
    if (!state.cancelRequested) {
      showToast('Error: ' + err.message, 'error');
      showErrorBanner(err.message);
      document.getElementById('emptyState').style.display = '';
    }
  }
}

// ===== POLL RUN STATUS =====
async function pollRunStatus(apiKey, runId) {
  if (!runId) throw new Error('No run ID');
  let attempts = 0;
  const maxAttempts = 150; // 5 min max

  return new Promise((resolve, reject) => {
    state.polling = setInterval(async () => {
      if (state.cancelRequested) {
        clearInterval(state.polling);
        return reject(new Error('Cancelled'));
      }
      if (++attempts > maxAttempts) {
        clearInterval(state.polling);
        return reject(new Error('Timed out. Try fewer results.'));
      }

      try {
        const res = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(apiKey)}`
        );
        const data = await res.json();
        const status = data.data?.status;
        const elapsed = (attempts * 2);

        console.log(`[LeadRadar] Poll #${attempts}: ${status} (${elapsed}s)`);

        const pct = Math.min(25 + (attempts / maxAttempts) * 50, 74);
        updateProgress(pct, 'Scraping Google Maps…', `Status: ${status} — ${elapsed}s elapsed`, 2);

        if (status === 'SUCCEEDED') {
          clearInterval(state.polling);
          const datasetId = data.data?.defaultDatasetId;
          console.log('[LeadRadar] Succeeded. Dataset ID:', datasetId);
          updateProgress(80, 'Fetching results...', 'Downloading dataset from Apify', 3);
          try {
            const items = await fetchDataset(apiKey, datasetId);
            console.log('[LeadRadar] Dataset items count:', items.length);
            if (items.length > 0) {
              console.log('[LeadRadar] Sample item keys:', Object.keys(items[0]));
              console.log('[LeadRadar] Sample item:', JSON.stringify(items[0]).slice(0, 500));
            }
            await processResults(items);
            resolve();
          } catch(fe) {
            reject(fe);
          }
        } else if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) {
          clearInterval(state.polling);
          reject(new Error(`Apify run ${status}. Check your Apify console for details.`));
        }
      } catch(pollErr) {
        console.warn('[LeadRadar] Poll fetch error (retrying):', pollErr.message);
      }
    }, 2000);
  });
}

// ===== FETCH DATASET =====
async function fetchDataset(apiKey, datasetId) {
  if (!datasetId) throw new Error('No dataset ID from completed run');

  // Try with limit parameter to ensure we get all items
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(apiKey)}&format=json&clean=true&limit=500`;
  console.log('[LeadRadar] Fetching dataset:', url);

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Dataset fetch failed (${res.status}): ${txt.slice(0,100)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error('Unexpected dataset format: ' + JSON.stringify(items).slice(0,200));
  }
  return items;
}

// ===== NORMALIZE ONE ITEM from Apify =====
// The compass/crawler-google-places actor returns varied field names
function normalizeItem(item) {
  // Parse totalScore — Apify may return it as a string or number
  const rawScore = item.totalScore ?? item.rating ?? null;
  const totalScore = rawScore !== null && rawScore !== undefined && rawScore !== ''
    ? parseFloat(rawScore)
    : null;

  // Parse reviewsCount — always ensure it's a number
  const rawReviews = item.reviewsCount ?? item.reviewCount ?? item.reviews ?? 0;
  const reviewsCount = parseInt(rawReviews) || 0;

  return {
    title:        item.title       || item.name        || item.placeName  || 'Unknown',
    categoryName: item.categoryName|| (Array.isArray(item.categories) ? item.categories[0] : null) || item.category || '—',
    address:      item.address     || item.fullAddress  || item.street     || '—',
    phone:        item.phone       || item.phoneUnformatted || item.phoneNumber || '',
    website:      item.website     || item.websiteUrl   || '',
    email:        item.email       || '',
    totalScore,   // always a number or null — never a string
    reviewsCount, // always a number
    url:          item.url         || item.placeUrl     || item.googleMapsUrl || '',
    city:         item.city        || '',
    state:        item.state       || item.stateName    || '',
    country:      item.country     || item.countryCode  || '',
    postalCode:   item.postalCode  || item.zip          || '',
    description:  item.description || item.about        || '',
    imageUrl:     item.imageUrl    || item.thumbnailUrl || '',
    openingHours: item.openingHours|| [],
  };
}

// ===== PROCESS RESULTS =====
async function processResults(items) {
  if (!Array.isArray(items)) {
    throw new Error('Results are not an array: ' + typeof items);
  }

  updateProgress(90, 'Processing data...', `Normalizing ${items.length} records`, 3);

  // Normalize ALL items and store as raw (NO filters applied yet)
  const normalized = items.map(normalizeItem);

  // Always remove items that have absolutely no rating data at all
  state.rawLeads = normalized.filter(l => {
    const score = parseFloat(l.totalScore);
    return !isNaN(score); // keep items that have any numeric score
  });

  console.log(`[LeadRadar] Raw leads (with any score): ${state.rawLeads.length} / ${normalized.length}`);

  // Now apply all user-selected filters on top of rawLeads
  const filtered = applyFilters(state.rawLeads);

  state.leads = filtered;
  state.allLeads = deduplicateLeads([...state.allLeads, ...filtered]);
  saveData();

  updateProgress(100, 'Complete!', `${filtered.length} leads ready`, 4);
  await sleep(700);

  setGenerateLoading(false);
  showProgressCard(false);
  hideErrorBanner();
  renderResults(filtered);
  updateStats();
  document.getElementById('sidebarLeadCount').textContent = state.allLeads.length;

  if (filtered.length === 0) {
    showToast('No leads matched your filters. Try removing filters or changing keywords.', 'info');
    document.getElementById('emptyState').style.display = '';
  } else {
    showToast(`✓ ${filtered.length} leads generated!`, 'success');
  }
}

// ===== APPLY FILTERS =====
// Uses state.activeFilters (locked at Generate-click time) — NEVER reads live DOM.
// This guarantees filter values match exactly what the user selected.
function applyFilters(sourceLeads) {
  const f = state.activeFilters;   // values locked when Generate was clicked

  console.log('[LeadRadar] applyFilters using locked filters:', JSON.stringify(f));

  let leads = [...sourceLeads];

  // ── STEP 1: ALWAYS remove leads with no valid numeric score or 0 reviews ──
  leads = leads.filter(l => {
    const score   = Number(l.totalScore);
    const reviews = parseInt(l.reviewsCount) || 0;
    const valid   = Number.isFinite(score) && reviews > 0;
    return valid;
  });
  console.log(`[LeadRadar] After null/zero removal: ${leads.length}`);

  // ── STEP 2: Rating range — strict both-inclusive ──
  if (f.ratingMin !== null && f.ratingMax !== null) {
    leads = leads.filter(l => {
      const score = Number(l.totalScore);
      return Number.isFinite(score) && score >= f.ratingMin && score <= f.ratingMax;
    });
    console.log(`[LeadRadar] After rating [${f.ratingMin}–${f.ratingMax}]: ${leads.length}`);
  }

  // ── STEP 3: Contact data requirements ──
  if (f.requirePhone)   leads = leads.filter(l => !!l.phone);
  if (f.requireWebsite) leads = leads.filter(l => !!l.website);
  if (f.requireEmail)   leads = leads.filter(l => !!l.email);

  // ── STEP 4: Strict Location filter (City-based) ──
  const requestedLocation = (state.lastLocation || '').toLowerCase().trim();
  if (requestedLocation) {
    // Split by comma to extract the city part (e.g. "Memphis, TN" -> "memphis")
    const locParts = requestedLocation.split(',').map(p => p.trim()).filter(Boolean);
    const cityQuery = locParts[0] || '';

    if (cityQuery.length > 2) {
      const before = leads.length;
      leads = leads.filter(l => {
        const cityVal = (l.city || '').toLowerCase();
        const addrVal = (l.address || '').toLowerCase();
        // The city name must appear in the city field or the full address
        return cityVal.includes(cityQuery) || addrVal.includes(cityQuery);
      });
      console.log(`[LeadRadar] Strict City Filter '${cityQuery}': ${before} → ${leads.length}`);
    }
  }

  // ── STEP 5: Slice results to exactly match the requested Max Results limit ──
  if (f.maxResults && leads.length > f.maxResults) {
    console.log(`[LeadRadar] Slicing output to match Max Results: ${leads.length} → ${f.maxResults}`);
    leads = leads.slice(0, f.maxResults);
  }

  console.log(`[LeadRadar] applyFilters FINAL: ${leads.length} leads`);
  return leads;
}

function deduplicateLeads(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = `${l.title}||${l.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== RENDER RESULTS =====
function renderResults(leads) {
  // ── FINAL SAFETY NET ── always strip invalid/null scores before rendering
  const safe = leads.filter(l => Number.isFinite(Number(l.totalScore)) && (parseInt(l.reviewsCount) || 0) > 0);

  // Re-enforce rating range using locked filter values (not live DOM)
  const f = state.activeFilters;
  let finalLeads = safe;
  if (f.ratingMin !== null && f.ratingMax !== null) {
    finalLeads = safe.filter(l => {
      const score = Number(l.totalScore);
      return Number.isFinite(score) && score >= f.ratingMin && score <= f.ratingMax;
    });
    console.log(`[LeadRadar] renderResults safety range [${f.ratingMin}–${f.ratingMax}]: ${safe.length} → ${finalLeads.length}`);
  }

  const section = document.getElementById('resultsSection');
  section.style.display = finalLeads.length ? '' : 'none';
  document.getElementById('emptyState').style.display = finalLeads.length ? 'none' : '';
  document.getElementById('resultCount').textContent =
    `${finalLeads.length} Lead${finalLeads.length !== 1 ? 's' : ''} Found`;
  renderTable(finalLeads);
  renderCards(finalLeads);
}

// ===== TABLE =====
function renderTable(leads) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = leads.map((l, i) => `
    <tr>
      <td>
        <div class="cell-name">
          <div class="biz-avatar" style="background:${getGradient(l.title)}">${getInitials(l.title)}</div>
          <span>${escHtml(l.title)}</span>
        </div>
      </td>
      <td><span class="category-chip" title="${escHtml(l.categoryName)}">${escHtml(truncate(l.categoryName, 22))}</span></td>
      <td class="addr-cell" title="${escHtml(l.address)}">${escHtml(l.address) || '<span class="no-data">—</span>'}</td>
      <td>${l.phone
        ? `<a href="tel:${escHtml(l.phone)}" class="link-chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
            ${escHtml(l.phone)}</a>`
        : '<span class="no-data">—</span>'}</td>
      <td>${l.website
        ? `<a href="${escHtml(l.website)}" target="_blank" rel="noopener" class="link-chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            Visit</a>`
        : '<span class="no-data">—</span>'}</td>
      <td>${Number.isFinite(l.totalScore)
        ? `<span class="rating-chip">⭐ ${l.totalScore.toFixed(1)}</span>`
        : '<span class="no-data">—</span>'}</td>
      <td style="color:var(--text-secondary)">${l.reviewsCount ? Number(l.reviewsCount).toLocaleString() : '—'}</td>
      <td>
        <div class="action-btns">
          <button class="action-btn" onclick="openLeadModal(${i})" title="View Details">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          ${l.url ? `<button class="action-btn" onclick="window.open('${escAttr(l.url)}','_blank')" title="Open in Maps">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </button>` : ''}
          <button class="action-btn" onclick="copyLead(${i})" title="Copy Info">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ===== CARDS =====
function renderCards(leads) {
  const grid = document.getElementById('cardsView');
  grid.innerHTML = leads.map((l, i) => `
    <div class="lead-card" onclick="openLeadModal(${i})">
      <div class="lead-card-header">
        <div class="lead-card-avatar" style="background:${getGradient(l.title)}">${getInitials(l.title)}</div>
        <div>
          <div class="lead-card-name">${escHtml(l.title)}</div>
          <div class="lead-card-cat">${escHtml(l.categoryName)}</div>
        </div>
      </div>
      <div class="lead-card-body">
        ${l.address ? `<div class="lead-info-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg><span>${escHtml(truncate(l.address, 40))}</span></div>` : ''}
        ${l.phone ? `<div class="lead-info-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg><span>${escHtml(l.phone)}</span></div>` : ''}
        ${l.website ? `<div class="lead-info-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg><a href="${escAttr(l.website)}" target="_blank" class="link-chip" onclick="event.stopPropagation()">${escHtml(truncate(l.website.replace(/https?:\/\/(www\.)?/,''), 30))}</a></div>` : ''}
        ${Number.isFinite(l.totalScore) ? `<div class="lead-info-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span style="color:var(--amber)">${l.totalScore.toFixed(1)} ★ · ${Number(l.reviewsCount||0).toLocaleString()} reviews</span></div>` : ''}
      </div>
    </div>
  `).join('');
}

// ===== VIEW TOGGLE =====
function setView(view) {
  state.currentView = view;
  document.getElementById('tableView').style.display  = view === 'table' ? '' : 'none';
  document.getElementById('cardsView').style.display  = view === 'cards' ? '' : 'none';
  document.getElementById('viewTable').classList.toggle('active', view === 'table');
  document.getElementById('viewCards').classList.toggle('active', view === 'cards');
}

// ===== FILTER =====
function filterResults() {
  const q = (document.getElementById('filterInput').value || '').toLowerCase();
  const filtered = state.leads.filter(l =>
    (l.title       || '').toLowerCase().includes(q) ||
    (l.address     || '').toLowerCase().includes(q) ||
    (l.categoryName|| '').toLowerCase().includes(q) ||
    (l.phone       || '').toLowerCase().includes(q)
  );
  renderTable(filtered);
  renderCards(filtered);
  document.getElementById('resultCount').textContent = `${filtered.length} of ${state.leads.length} Leads`;
}

function filterAllLeads() {
  const q = (document.getElementById('allLeadsFilter').value || '').toLowerCase();
  const filtered = state.allLeads.filter(l =>
    (l.title       || '').toLowerCase().includes(q) ||
    (l.address     || '').toLowerCase().includes(q) ||
    (l.categoryName|| '').toLowerCase().includes(q)
  );
  renderAllLeadsTable(filtered);
}

// ===== SORT =====
function sortTable(col) {
  if (state.sortCol === col) state.sortDir *= -1;
  else { state.sortCol = col; state.sortDir = 1; }
  const sorted = [...state.leads].sort((a, b) => {
    const av = a[col] ?? ''; const bv = b[col] ?? '';
    return av < bv ? -state.sortDir : av > bv ? state.sortDir : 0;
  });
  renderTable(sorted);
}

// ===== MODAL =====
function openLeadModal(index) {
  const l = state.leads[index];
  if (!l) return;
  document.getElementById('modalContent').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
      <div style="width:54px;height:54px;border-radius:14px;background:${getGradient(l.title)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.2rem;color:#fff;flex-shrink:0;">${getInitials(l.title)}</div>
      <div>
        <div class="modal-biz-name">${escHtml(l.title)}</div>
        <span class="category-chip">${escHtml(l.categoryName)}</span>
      </div>
    </div>
    <div class="modal-grid">
      <div class="modal-field modal-full"><label>Address</label><p>${escHtml(l.address) || '—'}</p></div>
      <div class="modal-field"><label>Phone</label><p>${l.phone ? `<a href="tel:${escHtml(l.phone)}">${escHtml(l.phone)}</a>` : '—'}</p></div>
      <div class="modal-field"><label>Email</label><p>${l.email ? `<a href="mailto:${escHtml(l.email)}">${escHtml(l.email)}</a>` : '—'}</p></div>
      <div class="modal-field"><label>Rating</label><p>${l.totalScore != null ? `⭐ ${l.totalScore} (${Number(l.reviewsCount||0).toLocaleString()} reviews)` : '—'}</p></div>
      <div class="modal-field"><label>Website</label><p>${l.website ? `<a href="${escAttr(l.website)}" target="_blank">${escHtml(l.website)}</a>` : '—'}</p></div>
      ${l.url ? `<div class="modal-field modal-full"><label>Google Maps</label><p><a href="${escAttr(l.url)}" target="_blank">View on Google Maps →</a></p></div>` : ''}
      ${l.description ? `<div class="modal-field modal-full"><label>Description</label><p>${escHtml(l.description)}</p></div>` : ''}
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;">
      ${l.phone   ? `<a href="tel:${escHtml(l.phone)}"   class="btn-secondary" style="text-decoration:none;font-size:0.8rem;">📞 Call</a>` : ''}
      ${l.website ? `<a href="${escAttr(l.website)}" target="_blank" class="btn-secondary" style="text-decoration:none;font-size:0.8rem;">🌐 Website</a>` : ''}
      ${l.email   ? `<a href="mailto:${escHtml(l.email)}" class="btn-secondary" style="text-decoration:none;font-size:0.8rem;">✉️ Email</a>` : ''}
      ${l.url     ? `<a href="${escAttr(l.url)}" target="_blank" class="btn-primary" style="text-decoration:none;font-size:0.8rem;">📍 Maps</a>` : ''}
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

// ===== COPY LEAD =====
function copyLead(index) {
  const l = state.leads[index];
  if (!l) return;
  const text = [l.title, l.categoryName, l.address, l.phone, l.website, l.email].filter(Boolean).join(' | ');
  navigator.clipboard.writeText(text).then(() => showToast('Lead copied!', 'success')).catch(() => showToast('Copy failed', 'error'));
}

// ===== EXPORT CSV =====
function exportCSV() {
  if (!state.leads.length) { showToast('No leads to export', 'error'); return; }
  downloadCSV(state.leads, 'leadradar_leads');
}
function exportAllCSV() {
  if (!state.allLeads.length) { showToast('No leads to export', 'error'); return; }
  downloadCSV(state.allLeads, 'leadradar_all_leads');
}
function downloadCSV(data, filename) {
  const headers = ['Business Name','Category','Address','Phone','Website','Email','Rating','Reviews','Google Maps URL'];
  const rows = data.map(l => [
    l.title, l.categoryName, l.address, l.phone, l.website, l.email,
    l.totalScore, l.reviewsCount, l.url
  ].map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`));
  const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `${filename}_${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
  showToast(`✓ Exported ${data.length} leads`, 'success');
}

// ===== STATS =====
function updateStats() {
  const leads = state.leads;
  document.getElementById('statTotalVal').textContent = leads.length;
  document.getElementById('statPhoneVal').textContent = leads.filter(l => l.phone).length;
  document.getElementById('statWebVal').textContent   = leads.filter(l => l.website).length;
  const rated = leads.filter(l => l.totalScore != null);
  document.getElementById('statRatingVal').textContent = rated.length
    ? (rated.reduce((s,l) => s + l.totalScore, 0) / rated.length).toFixed(1)
    : '—';
}

// ===== PROGRESS UI =====
function showProgressCard(show) {
  document.getElementById('progressCard').style.display = show ? '' : 'none';
}
function updateProgress(pct, title, sub, step) {
  document.getElementById('progressBarFill').style.width = pct + '%';
  document.getElementById('progressTitle').textContent = title;
  document.getElementById('progressSub').textContent = sub;
  for (let i = 1; i <= 4; i++) {
    const dot = document.querySelector(`#step${i} .step-dot`);
    if (dot) dot.className = 'step-dot' + (i < step ? ' done' : i === step ? ' active' : '');
  }
}
function setGenerateLoading(loading) {
  const btn  = document.getElementById('generateBtn');
  const text = document.getElementById('generateBtnText');
  const spin = document.getElementById('btnSpinner');
  btn.disabled = loading;
  text.textContent = loading ? 'Generating...' : 'Generate Leads';
  spin.className = 'btn-spinner' + (loading ? ' show' : '');
}

// ===== ERROR BANNER =====
function showErrorBanner(msg) {
  let banner = document.getElementById('errorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.style.cssText = 'background:rgba(244,63,94,0.1);border:1px solid rgba(244,63,94,0.35);border-radius:10px;padding:14px 18px;margin-bottom:18px;color:#f87171;font-size:0.85rem;line-height:1.6;';
    document.getElementById('tab-dashboard').insertBefore(banner, document.getElementById('emptyState'));
  }
  banner.innerHTML = `<strong>⚠ Error:</strong> ${escHtml(msg)}<br><small style="opacity:.7">Check your API key and try again. Open DevTools (F12) → Console for details.</small>`;
  banner.style.display = '';
}
function hideErrorBanner() {
  const b = document.getElementById('errorBanner');
  if (b) b.style.display = 'none';
}

// ===== CANCEL =====
function cancelRun() {
  state.cancelRequested = true;
  if (state.polling) clearInterval(state.polling);
  setGenerateLoading(false);
  showProgressCard(false);
  document.getElementById('emptyState').style.display = '';
  showToast('Cancelled', 'info');
  setApiStatus('disconnected');
  if (state.runId && state.apiKey) {
    fetch(`https://api.apify.com/v2/actor-runs/${state.runId}/abort?token=${encodeURIComponent(state.apiKey)}`, { method: 'POST' }).catch(() => {});
  }
}

// ===== CLEAR FORM =====
function clearForm() {
  ['searchQuery','location'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('maxResults').value  = '20';
  document.getElementById('ratingRange').value = '';
  ['requirePhone','requireWebsite','requireEmail'].forEach(id => document.getElementById(id).checked = false);
  showToast('Form cleared', 'info');
}

// ===== LEADS TAB =====
function refreshLeadsTab() {
  const empty   = document.getElementById('leadsTabEmpty');
  const content = document.getElementById('leadsTabContent');
  if (!state.allLeads.length) {
    empty.style.display = ''; content.style.display = 'none';
  } else {
    empty.style.display = 'none'; content.style.display = '';
    document.getElementById('allLeadsCount').textContent = state.allLeads.length;
    renderAllLeadsTable(state.allLeads);
  }
}
function renderAllLeadsTable(leads) {
  document.getElementById('allLeadsBody').innerHTML = leads.map((l, i) => `
    <tr>
      <td><div class="cell-name"><div class="biz-avatar" style="background:${getGradient(l.title)}">${getInitials(l.title)}</div>${escHtml(l.title)}</div></td>
      <td><span class="category-chip">${escHtml(truncate(l.categoryName, 22))}</span></td>
      <td class="addr-cell">${escHtml(l.address) || '—'}</td>
      <td>${l.phone ? `<a href="tel:${escHtml(l.phone)}" class="link-chip">${escHtml(l.phone)}</a>` : '<span class="no-data">—</span>'}</td>
      <td>${l.website ? `<a href="${escAttr(l.website)}" target="_blank" class="link-chip">Visit</a>` : '<span class="no-data">—</span>'}</td>
      <td>${l.totalScore != null ? `<span class="rating-chip">⭐ ${l.totalScore}</span>` : '—'}</td>
      <td>${Number(l.reviewsCount||0).toLocaleString()}</td>
      <td><div class="action-btns">
        ${l.url ? `<button class="action-btn" onclick="window.open('${escAttr(l.url)}','_blank')" title="Maps"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg></button>` : ''}
        <button class="action-btn" onclick="removeAllLead(${i})" title="Remove"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg></button>
      </div></td>
    </tr>
  `).join('');
}
function removeAllLead(i) {
  state.allLeads.splice(i, 1);
  saveData();
  refreshLeadsTab();
  document.getElementById('sidebarLeadCount').textContent = state.allLeads.length;
  showToast('Lead removed', 'info');
}

// ===== SETTINGS =====
function refreshSettings() {
  document.getElementById('savedApiKey').value = state.apiKey || '';
}
async function testApiKey() {
  const key = state.apiKey || document.getElementById('apiKey').value.trim();
  if (!key) { showToast('No API key to test', 'error'); return; }
  const result = document.getElementById('connectionResult');
  result.style.display = ''; result.className = 'connection-result';
  result.textContent = '⏳ Testing connection…';
  try {
    const res  = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`);
    const data = await res.json();
    if (res.ok && data.data?.username) {
      result.className = 'connection-result success';
      result.textContent = `✓ Connected as @${data.data.username} — ${data.data.plan?.id || 'Free'} plan`;
      setApiStatus('connected');
    } else {
      throw new Error(data.error?.message || 'Invalid API key');
    }
  } catch(err) {
    result.className = 'connection-result error';
    result.textContent = '✗ ' + err.message;
    setApiStatus('disconnected');
  }
}
function clearSavedKey() {
  // Restore default API key instead of leaving blank
  const keyToRestore = DEFAULT_API_KEY || '';
  state.apiKey = keyToRestore;
  document.getElementById('apiKey').value    = keyToRestore;
  document.getElementById('savedApiKey').value = keyToRestore;
  // Only remove the custom key from storage; default will be picked up on next load
  const saved = JSON.parse(localStorage.getItem('leadradar') || '{}');
  delete saved.apiKey;
  localStorage.setItem('leadradar', JSON.stringify(saved));
  if (keyToRestore) {
    setApiStatus('connected');
    showToast('API key reset to default', 'info');
  } else {
    setApiStatus('disconnected');
    showToast('API key cleared', 'info');
  }
}
function clearAllData() {
  if (!confirm('Clear ALL saved leads? (API key will be kept)')) return;
  // Only wipe leads — preserve the API key
  const currentKey = state.apiKey || DEFAULT_API_KEY;
  localStorage.removeItem('leadradar');
  state.leads    = [];
  state.allLeads = [];
  state.rawLeads = [];
  // Re-save just the key so the app stays connected
  state.apiKey = currentKey;
  saveData();
  document.getElementById('apiKey').value = currentKey;
  document.getElementById('sidebarLeadCount').textContent = '0';
  updateStats();
  setApiStatus('connected');
  showToast('All leads cleared. API key kept.', 'success');
}
function updatePreferences() { saveData(); }

// ===== TOAST =====
let toastTimer;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3800);
}

// ===== HELPERS =====
function getInitials(name) {
  if (!name) return '?';
  const w = String(name).trim().split(/\s+/);
  return w.length === 1 ? w[0].slice(0,2).toUpperCase() : (w[0][0] + w[1][0]).toUpperCase();
}
function truncate(str, n) {
  if (!str || str === '—') return str || '—';
  return str.length > n ? str.slice(0, n) + '…' : str;
}
function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(str) {
  if (str == null) return '';
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const GRADIENTS = [
  'linear-gradient(135deg,#6366f1,#8b5cf6)',
  'linear-gradient(135deg,#06b6d4,#6366f1)',
  'linear-gradient(135deg,#8b5cf6,#ec4899)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#10b981,#06b6d4)',
  'linear-gradient(135deg,#f43f5e,#8b5cf6)',
];
function getGradient(name) {
  let h = 0;
  for (const c of (name||'')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return GRADIENTS[h % GRADIENTS.length];
}
