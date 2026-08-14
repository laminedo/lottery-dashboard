'use strict';
/* Static web app — no backend. All analysis runs in the browser via LottoEngine.
   Draw history is fetched from NY Open Data and cached in localStorage. */

const E = window.LottoEngine;
const $ = (selector) => document.querySelector(selector);

const els = {
  appTitle: $('#appTitle'),
  freshness: $('#freshness'),
  gameSwitch: $('#gameSwitch'),
  fetchHistoryButton: $('#fetchHistoryButton'),
  dataHealth: $('#dataHealth'),
  jackpotTicker: $('#jackpotTicker'),
  fetchHistoryButton2: $('#fetchHistoryButton2'),
  clearDataButton: $('#clearDataButton'),
  exportCsvButton: $('#exportCsvButton'),
  dataStatus: $('#dataStatus'),
  totalMetricLabel: $('#totalMetricLabel'),
  totalPossible: $('#totalPossible'),
  ruleDescription: $('#ruleDescription'),
  historyCount: $('#historyCount'),
  coverageLabel: $('#coverageLabel'),
  remainingCount: $('#remainingCount'),
  latestDrawDate: $('#latestDrawDate'),
  latestDrawNumbers: $('#latestDrawNumbers'),
  searchForm: $('#searchForm'),
  lookupFields: $('#lookupFields'),
  clearLookupButton: $('#clearLookupButton'),
  searchResult: $('#searchResult'),
  insightGrid: $('#insightGrid'),
  heatmapMode: $('#heatmapMode'),
  heatmapTitle: $('#heatmapTitle'),
  megaHeatTitle: $('#megaHeatTitle'),
  whiteHeatmap: $('#whiteHeatmap'),
  megaHeatmap: $('#megaHeatmap'),
  legendNote: $('#legendNote'),
  whiteFreqChart: $('#whiteFreqChart'),
  sumChart: $('#sumChart'),
  oddEvenChart: $('#oddEvenChart'),
  lowHighChart: $('#lowHighChart'),
  pairsList: $('#pairsList'),
  strategyPicker: $('#strategyPicker'),
  strategyTagline: $('#strategyTagline'),
  predictionRefreshButton: $('#predictionRefreshButton'),
  savePicksButton: $('#savePicksButton'),
  ticketsList: $('#ticketsList'),
  ticketBadge: $('#ticketBadge'),
  verificationSummary: $('#verificationSummary'),
  liveSyncStatusBadge: $('#liveSyncStatusBadge'),
  liveSyncText: $('#liveSyncText'),
  testNotifButton: $('#testNotifButton'),
  notifStatus: $('#notifStatus'),
  predictionNotice: $('#predictionNotice'),
  patternSummary: $('#patternSummary'),
  predictionMethod: $('#predictionMethod'),
  predictionCards: $('#predictionCards'),
  historyFilter: $('#historyFilter'),
  historyTable: $('#historyTable'),
  remainingSummary: $('#remainingSummary'),
  remainingTable: $('#remainingTable'),
  remainingResetButton: $('#remainingResetButton'),
  remainingNextButton: $('#remainingNextButton'),
  historyFileInput: $('#historyFileInput'),
  fileName: $('#fileName'),
  uploadHistoryButton: $('#uploadHistoryButton'),
  importText: $('#importText'),
  importHistoryButton: $('#importHistoryButton'),
  methodologyText: $('#methodologyText'),
  toast: $('#toast')
};

let currentGame = 'mega';
let currentStrategy = 'balanced';
let predictionSalt = '';
let heatmapModeValue = 'hot';
let records = [];
let winnerIndex = new Map();
let latestAnalysis = null;
let latestPredictions = [];
let justSavedTicketId = null;
let remainingPageAfter = 0;
let latestRemaining = null;
let drawnWhiteSet = new Set();
let drawnBonusSet = new Set();
const selectedGameKey = 'lotto-current-game';

const config = () => E.GAME_CONFIGS[currentGame];
const storageKey = () => `lotto-history-${currentGame}`;
const updatedKey = () => `lotto-updated-${currentGame}`;
const ticketsKey = () => `lotto-tickets-${currentGame}`;
const formatNumber = (value) => Number(value || 0).toLocaleString();
const bonusOn = () => config().hasBonus !== false;
const bonusBall = (value) => (bonusOn() ? `<span class="ball mega">${value}</span>` : '');

function loadSavedGame() {
  const saved = localStorage.getItem(selectedGameKey);
  if (saved && E.GAME_CONFIGS[saved]) currentGame = saved;
}

function saveSelectedGame() {
  try {
    localStorage.setItem(selectedGameKey, currentGame);
  } catch {
    // ignore blocked storage
  }
}

function setActiveGameButton() {
  els.gameSwitch.querySelectorAll('.seg-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.game === currentGame);
  });
}

function loadSavedGame() {
  const saved = localStorage.getItem(selectedGameKey);
  if (saved && E.GAME_CONFIGS[saved]) currentGame = saved;
}

function lastUpdatedLabel() {
  const stamp = localStorage.getItem(updatedKey());
  if (!stamp) return 'never updated';
  const date = new Date(stamp);
  return Number.isNaN(date.valueOf()) ? 'never updated' : `updated ${date.toLocaleString()}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/* ---------- Data ---------- */

async function loadSaved() {
  try {
    records = await LottoStore.getDraws(currentGame);
    if (!records.length) {
      const cfg = config();
      if (cfg.historyUrl) {
        try {
          const response = await fetch(cfg.historyUrl, { headers: { accept: 'application/json' } });
          if (response.ok) {
            const raw = await response.json();
            const normalized = E.normalizeHistory(raw, cfg);
            await LottoStore.insertDraws(currentGame, normalized, false);
            records = LottoStore.getCachedDraws(currentGame);
          }
        } catch { /* ignore bundled fetch fail */ }
      }
    }
  } catch {
    records = [];
  }
  winnerIndex = E.buildWinnerIndex(records);
}

async function save() {
  try {
    await LottoStore.insertDraws(currentGame, records);
    localStorage.setItem(updatedKey(), new Date().toISOString());
  } catch {
    showToast('Could not save history in this browser (storage full or blocked).');
  }
}

function prizeTierForMatch(whites, bonus, cfg) {
  const tiers = E.PRIZE_TIERS?.[cfg.id] || [];
  for (const tier of tiers) {
    if (tier.match !== whites) continue;
    if (tier.bonus === bonus || tier.bonus == null) return tier;
  }
  return null;
}

function renderTicketPickBalls(pick, draw, cfg) {
  const bonus = cfg.hasBonus !== false;
  if (draw && draw.numbers) {
    if (cfg.ordered) {
      const parts = pick.numbers.map((n, i) => {
        const isMatch = draw.numbers[i] === n;
        return `<span class="ball${isMatch ? ' match' : ''}">${n}</span>`;
      });
      if (bonus) {
        const bonusMatched = draw.megaBall === pick.megaBall;
        parts.push(`<span class="ball mega${bonusMatched ? ' match' : ''}">${pick.megaBall}</span>`);
      }
      return parts.join('');
    } else {
      const matchedWhites = new Set(draw.numbers);
      const parts = pick.numbers.map((n) => `<span class="ball${matchedWhites.has(n) ? ' match' : ''}">${n}</span>`);
      if (bonus) {
        const bonusMatched = draw.megaBall === pick.megaBall;
        parts.push(`<span class="ball mega${bonusMatched ? ' match' : ''}">${pick.megaBall}</span>`);
      }
      return parts.join('');
    }
  }
  const parts = pick.numbers.map((n) => `<span class="ball">${n}</span>`);
  if (bonus) parts.push(`<span class="ball mega">${pick.megaBall}</span>`);
  return parts.join('');
}

/* ---------- Data health strip (bundled archive freshness per game) ---------- */

async function renderDataHealth() {
  if (!els.dataHealth) return;
  try {
    // Prefer the <script src> global (works on file://); fall back to fetch (http).
    let meta = window.HISTORY_META || null;
    if (!meta) {
      const response = await fetch('history_meta.json', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('no meta');
      meta = await response.json();
    }
    const now = Date.now();
    const localMeta = Object.values(E.GAME_CONFIGS).reduce((acc, cfg) => {
      try {
        const stored = JSON.parse(localStorage.getItem(`lotto-history-${cfg.id}`) || '[]');
        if (stored.length) {
          const newest = stored.reduce((max, row) => {
            if (row.drawDate && String(row.drawDate) > max) return String(row.drawDate);
            return max;
          }, '');
          const draws = stored.length;
          if (newest) acc[cfg.id] = { draws, newest };
        }
      } catch {
        // ignore invalid local storage content
      }
      return acc;
    }, {});
    const pills = Object.values(E.GAME_CONFIGS).map((cfg) => {
      const bundle = meta.games?.[cfg.id];
      const local = localMeta[cfg.id];
      const newest = local?.newest || bundle?.newest;
      if (!newest) return '';
      const ageDays = (now - new Date(`${newest}T00:00:00`).valueOf()) / 86400000;
      const state = ageDays <= 4 ? 'fresh' : ageDays <= 10 ? 'aging' : 'stale';
      const labelDate = newest.slice(5);
      const extra = local?.newest && local.newest !== bundle?.newest ? ' · loaded' : '';
      return `<button class="health-pill ${state}${cfg.id === currentGame ? ' active' : ''}" data-game="${cfg.id}"
        title="${cfg.label}: ${formatNumber(local?.draws || bundle?.draws || 0)} draws${extra}, latest ${newest}">
        <i></i>${escapeHtml(cfg.label)} <b>${escapeHtml(labelDate)}</b></button>`;
    }).join('');
    const stamp = meta.generatedAt ? `<span class="health-stamp">bundles refreshed ${escapeHtml(meta.generatedAt.slice(0, 10))}</span>` : '';
    els.dataHealth.innerHTML = pills + stamp;
  } catch {
    els.dataHealth.innerHTML = '';
  }
}

els.dataHealth?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-game]');
  if (button && button.dataset.game !== currentGame) {
    const switchBtn = els.gameSwitch.querySelector(`[data-game="${button.dataset.game}"]`);
    if (switchBtn) switchBtn.click();
  }
});

/* ---------- Jackpot ticker (current estimated jackpots) ---------- */

const JACKPOT_CACHE_KEY = 'lotto-jackpots-v2';
const JACKPOT_TTL = 6 * 60 * 60 * 1000; // 6 hours

function shortJackpot(amount, unit) {
  const n = Number(amount);
  if (String(unit).toLowerCase().startsWith('b')) return `$${n}B`;
  return n >= 1000 ? `$${(n / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}B` : `$${n}M`;
}

/* Compact display for raw amounts like "$2 Million", "$165,000", "$500". */
function fmtJackpot(raw) {
  const m = String(raw).match(/\$([\d.,]+)\s*(Million|Billion)?/i);
  if (!m) return String(raw);
  if (m[2]) return shortJackpot(m[1].replace(/,/g, ''), m[2]);
  const n = Number(m[1].replace(/,/g, ''));
  return n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
}

function renderJackpots(data) {
  if (!els.jackpotTicker || !data) return;
  const items = Object.values(E.GAME_CONFIGS)
    .filter((cfg) => data[cfg.id])
    .map((cfg) => {
      const active = cfg.id === currentGame ? ' active' : '';
      return `<button class="jackpot-pill${active}" data-game="${cfg.id}" title="${cfg.label} estimated jackpot (via lotteryusa.com, cached 6h)">
        🎰 ${escapeHtml(cfg.label)} <b>${escapeHtml(data[cfg.id])}</b></button>`;
    }).join('');
  els.jackpotTicker.innerHTML = items
    ? `${items}<span class="health-stamp">estimated jackpots · updated ${escapeHtml(new Date(data.fetchedAt).toLocaleString())}</span>`
    : '';
}

const JACKPOT_NAME_MAP = {
  'lotto': 'walotto', 'washington lotto': 'walotto', 'wa lotto': 'walotto',
  'hit 5': 'hit5', 'hit5': 'hit5',
  'powerball': 'powerball',
  'mega millions': 'mega', 'mega': 'mega'
};

async function fetchJackpots() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(JACKPOT_CACHE_KEY) || 'null'); } catch { /* ignore */ }
  if (cached) renderJackpots(cached);
  if (cached && Date.now() - new Date(cached.fetchedAt).valueOf() < JACKPOT_TTL) return;
  const data = { fetchedAt: new Date().toISOString() };
  // Source 1: lotteryusa WA page - one page covers all 7 tracked games.
  for (const relay of CORS_RELAYS) {
    try {
      const response = await fetch(relay('https://www.lotteryusa.com/washington/'));
      if (!response.ok) continue;
      const html = await response.text();
      const re = /c-game-result-card__title">([^<]+)<\/span>[\s\S]{0,300}?(?:Est\. jackpot|Jackpot|Top [Pp]rize)?:?\s*<strong>([^<]+)<\/strong>/gi;
      let m;
      while ((m = re.exec(html))) {
        const key = JACKPOT_NAME_MAP[m[1].trim().toLowerCase()];
        if (key && !data[key]) data[key] = fmtJackpot(m[2]);
      }
      if (Object.keys(data).length > 1) break;
    } catch { /* try next relay */ }
  }
  // Source 2: lottery.net homepage - fallback for Mega Millions / Powerball.
  if (!data.mega || !data.powerball) {
    for (const relay of CORS_RELAYS) {
      try {
        const response = await fetch(relay('https://www.lottery.net/'));
        if (!response.ok) continue;
        const html = await response.text();
        const re = /jackpot-promo\/people\/(mega-millions|powerball)\.png[\s\S]{0,600}?Next Estimated Jackpot[\s\S]{0,200}?\$([\d.]+)\s*(Million|Billion)/gi;
        let m;
        while ((m = re.exec(html))) {
          const key = m[1] === 'mega-millions' ? 'mega' : 'powerball';
          if (!data[key]) data[key] = shortJackpot(m[2], m[3]);
        }
        if (data.mega && data.powerball) break;
      } catch { /* try next relay */ }
    }
  }
  if (Object.keys(data).length > 1) {
    localStorage.setItem(JACKPOT_CACHE_KEY, JSON.stringify(data));
    renderJackpots(data);
  }
  // All sources failed: keep showing cached values (if any) silently.
}

els.jackpotTicker?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-game]');
  if (button && button.dataset.game !== currentGame) {
    const switchBtn = els.gameSwitch.querySelector(`[data-game="${button.dataset.game}"]`);
    if (switchBtn) switchBtn.click();
  }
});

/* ---------- Saved tickets (per game) ---------- */

function loadTickets() {
  try {
    return JSON.parse(localStorage.getItem(ticketsKey()) || '[]');
  } catch {
    return [];
  }
}

function saveTickets(tickets) {
  try {
    localStorage.setItem(ticketsKey(), JSON.stringify(tickets));
  } catch {
    showToast('Could not save tickets (storage full or blocked).');
  }
}

/* Best match of one pick against a set of draw records. */
function bestMatch(pick, drawSet) {
  let best = null;
  for (const draw of drawSet) {
    const whites = pick.numbers.filter((n) => draw.numbers.includes(n)).length;
    const bonus = draw.megaBall === pick.megaBall;
    const rank = whites * 2 + (bonus ? 1 : 0);
    if (!best || rank > best.rank) best = { drawDate: draw.drawDate, whites, bonus, rank };
  }
  return best;
}

/* Check saved tickets against newly added draws; returns the best hit (if any). */
function checkTicketsAgainst(newDraws) {
  if (!newDraws.length) return null;
  let top = null;
  for (const ticket of loadTickets()) {
    for (const pick of ticket.picks) {
      const hit = bestMatch(pick, newDraws);
      if (hit && (!top || hit.rank > top.rank)) top = { ...hit, pick, ticketId: ticket.id };
    }
  }
  return top;
}

function renderTickets() {
  const tickets = loadTickets();
  if (els.ticketBadge) {
    els.ticketBadge.textContent = tickets.length ? String(tickets.length) : '';
    els.ticketBadge.classList.toggle('hidden', !tickets.length);
  }
  const cfg = config();
  const bonus = cfg.hasBonus !== false;
  const latestDraw = records[0] || null;

  // Update Live Sync Status Indicator
  if (els.liveSyncText) {
    els.liveSyncText.textContent = latestDraw
      ? `Live Draw Sync: Active (${latestDraw.drawDate})`
      : 'Live Draw Sync: Waiting for draw data';
  }

  if (!tickets.length) {
    if (els.verificationSummary) {
      els.verificationSummary.innerHTML = `
        <div class="empty-tickets-hero">
          <div class="empty-icon">🎯</div>
          <h3>No Saved Numbers Yet</h3>
          <p class="muted">Generate combinations in the <strong>Predictor</strong> tab and tap <strong>Save Picks</strong>. The Prize Verification Engine automatically syncs with official draws and validates all your combinations in real-time.</p>
        </div>`;
    }
    els.ticketsList.innerHTML = '<p class="muted">No saved tickets yet. Go to the Predictor tab, generate Balance picks, and tap "Save Picks".</p>';
    return;
  }

  // Run comprehensive Prize Verification Engine across all saved numbers
  const verification = E.verifySavedTickets(tickets, latestDraw, cfg);

  // Render Verification Summary Banner & KPIs
  if (els.verificationSummary) {
    const bannerClass = verification.hasJackpot ? 'jackpot' : verification.hasTier2 ? 'tier2' : verification.hasWinningMatch ? 'winning' : 'neutral';
    const bannerText = verification.hasJackpot
      ? `🎰 <strong>JACKPOT DETECTED!</strong> One or more saved combinations matched all winning numbers for the official draw on ${latestDraw?.drawDate}!`
      : verification.hasTier2
        ? `🏆 <strong>TIER 2 WINNER FLAGGED!</strong> A saved combination matched winning numbers for an estimated prize of $1,000,000 on ${latestDraw?.drawDate}!`
        : verification.hasWinningMatch
          ? `✨ <strong>${verification.winningPicksCount} WINNING COMBINATION${verification.winningPicksCount === 1 ? '' : 'S'} FLAGGED!</strong> Estimated prize payout: $${formatNumber(verification.totalEstimatedPrize)}`
          : `All ${verification.totalPicks} saved combinations checked against the latest official draw (${latestDraw?.drawDate || 'N/A'}). No winning prize tier hit in this draw.`;

    const latestDrawBallsHtml = latestDraw
      ? `<div class="latest-draw-strip">
          <span class="draw-label">Official Winning Numbers (${escapeHtml(latestDraw.drawDate)}):</span>
          <div class="balls mini">${latestDraw.numbers.map((n) => `<span class="ball">${n}</span>`).join('')}${bonusBall(latestDraw.megaBall)}</div>
        </div>`
      : '';

    els.verificationSummary.innerHTML = `
      ${latestDrawBallsHtml}
      <div class="win-banner ${bannerClass}">${bannerText}</div>
      <div class="verification-kpis">
        <div class="vkpi">
          <span>Checked Picks</span>
          <strong>${formatNumber(verification.totalPicks)}</strong>
          <small>${formatNumber(verification.totalTickets)} ticket${verification.totalTickets === 1 ? '' : 's'}</small>
        </div>
        <div class="vkpi">
          <span>Winning Matches</span>
          <strong class="${verification.winningPicksCount ? 'green' : ''}">${formatNumber(verification.winningPicksCount)}</strong>
          <small>${verification.winningPicksCount ? 'Official tier hit' : '0 in latest draw'}</small>
        </div>
        <div class="vkpi">
          <span>Highest Win Status</span>
          <strong class="${verification.hasJackpot ? 'gold' : verification.hasTier2 ? 'green' : ''}">${verification.highestTier ? escapeHtml(verification.highestTier.status) : 'No Match'}</strong>
          <small>${verification.highestTier ? escapeHtml(verification.highestTier.tierName) : 'No tier hit'}</small>
        </div>
        <div class="vkpi">
          <span>Est. Prize Payout</span>
          <strong class="${verification.totalEstimatedPrize ? 'gold' : ''}">${verification.totalEstimatedPrize > 0 ? '$' + formatNumber(verification.totalEstimatedPrize) : verification.hasJackpot ? 'Jackpot' : '$0'}</strong>
          <small>Latest official draw</small>
        </div>
      </div>
    `;
  }

  // Render individual tickets with dynamic tier matching
  els.ticketsList.innerHTML = tickets.map((ticket) => {
    const verifiedResults = (ticket.picks || []).map((pick) => {
      const ver = latestDraw ? E.verifyPickAgainstDraw(pick, latestDraw, cfg) : null;
      const ever = bestMatch(pick, records);
      const since = bestMatch(pick, records.filter((r) => r.drawDate >= ticket.savedAt.slice(0, 10)));
      return { pick, ver, ever, since };
    });

    const hasWinInTicket = verifiedResults.some((r) => r.ver && r.ver.isWin);

    return `
    <article class="ticket-card${ticket.id === justSavedTicketId ? ' new' : ''}${hasWinInTicket ? ' has-win' : ''}">
      <div class="ticket-head">
        <div class="ticket-head-left">
          <span>Saved ${escapeHtml(new Date(ticket.savedAt).toLocaleString())} · Strategy: <strong>${escapeHtml(ticket.strategy || 'Balance')}</strong></span>
          ${hasWinInTicket ? '<span class="ticket-win-pill">WINNING TICKET</span>' : ''}
        </div>
        <button class="btn small danger" data-delete-ticket="${escapeHtml(ticket.id)}">Delete</button>
      </div>
      ${verifiedResults.map(({ pick, ver, ever, since }) => {
        const statusClass = ver ? (ver.status.toLowerCase().replace(/\s+/g, '-')) : 'none';
        const matchLabel = (m) => m ? `${m.whites} number${m.whites === 1 ? '' : 's'}${bonus && m.bonus ? ' + ' + cfg.ballLabel : ''} on ${m.drawDate}` : 'no draws checked';
        const good = ever && (ever.whites >= 3 || (bonus && ever.whites >= 2 && ever.bonus));

        return `
        <div class="ticket-pick${ver && ver.isWin ? ' pick-winning' : ''}">
          <div class="ticket-pick-left">
            <div class="balls">${renderTicketPickBalls(pick, latestDraw, cfg)}</div>
            ${ver ? `<span class="status-badge ${statusClass}">${escapeHtml(ver.status.toUpperCase())}</span>` : ''}
          </div>
          <div class="ticket-results">
            ${ver ? `
              <div class="tier-match-line">
                <strong class="${ver.isWin ? 'win-text' : ''}">${escapeHtml(ver.tierName)}</strong>
                <span class="prize-tag">${escapeHtml(ver.prizeFormatted)}</span>
              </div>
              <span class="ticket-match latest${ver.whiteMatchCount > 0 || ver.matchedBonus ? ' hit' : ''}">
                Latest draw (${escapeHtml(latestDraw.drawDate)}): Matched ${ver.whiteMatchCount} number${ver.whiteMatchCount === 1 ? '' : 's'}${bonus && ver.matchedBonus ? ' + ' + cfg.ballLabel : ''}
              </span>` : ''}
            <span class="ticket-match${good ? ' good' : ''}">Best ever historical: ${escapeHtml(matchLabel(ever))}</span>
            <span class="ticket-match">Since saved: ${escapeHtml(matchLabel(since))}</span>
          </div>
        </div>`;
      }).join('')}
      ${(() => {
        const sim = E.simulatePicks(ticket.picks, records, cfg);
        const money = (v) => `$${formatNumber(Math.round(v))}`;
        const roi = (sim.returnRate * 100).toFixed(1);
        return `
      <div class="ticket-sim">
        <div class="sim-head">&#9654; What-if simulation: playing these ${sim.lines} picks every draw for the whole loaded history</div>
        <div class="sim-stats">
          <span>${formatNumber(sim.draws)} draws</span>
          <span>Spent <strong>${money(sim.spent)}</strong></span>
          ${sim.hasDollarTable ? `<span>Won back <strong>${money(sim.totalWon)}</strong> (${roi}%)</span>` : ''}
          <span>Net <strong class="${sim.net >= 0 ? 'good' : 'bad'}">${sim.net >= 0 ? '+' + money(sim.net) : '−' + money(-sim.net)}</strong></span>
          ${sim.jackpots ? `<span class="sim-jackpot">&#127922; JACKPOT × ${sim.jackpots}</span>` : '<span>Jackpots: 0</span>'}
        </div>
        ${sim.tiers.length ? `<div class="sim-tiers">${sim.tiers.map(({ tier, count }) => `<span class="sim-tier">${escapeHtml(tier.label)} × ${formatNumber(count)}${tier.prize ? ` (${money(tier.prize * count)})` : ''}</span>`).join('')}</div>` : ''}
        <div class="sim-note">Estimated from published fixed prizes at $${sim.price}/play; jackpots are pari-mutuel and counted but not valued. Past results do not predict future draws.</div>
      </div>`;
      })()}
    </article>
  `;
  }).join('');
}


/* Live results pages for games with no open-data API, read through public CORS relays. */
const LIVE_PAGES = {
  hit5: 'https://www.lotteryusa.com/washington/hit-5/year',
  walotto: 'https://www.lotteryusa.com/washington/lotto/year'
};
/* Official walottery.com "Past Drawings" endpoint (last 180 days), tried directly
   (it often sends Access-Control-Allow-Origin: *) and then through the relays. */
const WA_OFFICIAL = {
  hit5: 'hit5',
  walotto: 'lotto'
};
const waOfficialUrl = (game) => `https://walottery.com/winningnumbers/pastdrawings.aspx?gamename=${WA_OFFICIAL[game]}&unittype=day&unitcount=180`;
/* Open-data APIs (CORS-friendly, no relay needed) fetched on top of the bundled
   archive so Mega Millions stays current between bundle refreshes. */
const LIVE_APIS = {
  mega: 'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=2000&$order=draw_date%20DESC',
  powerball: 'https://data.ny.gov/resource/d6yy-54nr.json?$limit=2000&$order=draw_date%20DESC'
};
const CORS_RELAYS = [
  (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
];
/* How many days old the newest saved draw may be before auto-updating. */
const STALE_DAYS = { mega: 3, powerball: 3, hit5: 1.5, walotto: 2 };

/* Robust Network Utilities: Exponential Backoff & Detailed HTTP Status Logging */
async function fetchWithRetryAndLogging(url, options = {}, retryConfig = {}) {
  const {
    maxRetries = 2,
    initialDelayMs = 800,
    backoffFactor = 2,
    jitterMs = 300,
    timeoutMs = 9000,
    retryOnStatus = [408, 429, 500, 502, 503, 504]
  } = retryConfig;

  let lastError = null;
  let lastResponse = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      lastResponse = response;
      const status = response.status;
      const statusText = response.statusText || 'Unknown Status';

      // Detailed HTTP Status Code Error Logging
      let diagnosis = '';
      if (status === 403) diagnosis = '403 Forbidden: Blocked by upstream CORS policy or Cloudflare WAF/Bot Protection.';
      else if (status === 404) diagnosis = '404 Not Found: Endpoint URL or game query parameter is invalid.';
      else if (status === 429) diagnosis = '429 Too Many Requests: Rate limit exceeded on upstream provider.';
      else if (status >= 500 && status < 600) diagnosis = `${status} Server Error: Upstream lottery server or gateway failed.`;
      else diagnosis = `${status} ${statusText}`;

      console.warn(`[Lottery Sync HTTP ${status}] Attempt ${attempt}/${maxRetries + 1} failed for ${url}\n  -> Reason: ${diagnosis}`);

      // If status is not retryable (e.g. 404 or 400), don't waste time retrying
      if (!retryOnStatus.includes(status) && status !== 403) {
        return response;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      const isTimeout = err.name === 'AbortError';
      const isCorsOrNetwork = err instanceof TypeError;
      const errorType = isTimeout ? 'Timeout (> ' + timeoutMs + 'ms)' : isCorsOrNetwork ? 'CORS / Network Error' : err.message;

      console.warn(`[Lottery Sync Network Error] Attempt ${attempt}/${maxRetries + 1} failed for ${url}\n  -> Exception: ${errorType}`);
    }

    if (attempt <= maxRetries) {
      const delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1) + Math.random() * jitterMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error(`Network failure fetching ${url}`);
}

async function fetchLivePage(url, cfg) {
  const errors = [];
  for (let i = 0; i < CORS_RELAYS.length; i++) {
    const relayUrl = CORS_RELAYS[i](url);
    try {
      const response = await fetchWithRetryAndLogging(relayUrl, {}, { maxRetries: 1, timeoutMs: 8000 });
      if (response && response.ok) {
        const text = await response.text();
        const rows = E.parseLooseDrawText(text, cfg);
        if (rows && rows.length) return rows;
      } else if (response) {
        errors.push(`Relay #${i + 1} returned HTTP ${response.status} (${response.statusText})`);
      }
    } catch (err) {
      errors.push(`Relay #${i + 1} error: ${err.message}`);
    }
  }
  if (errors.length) {
    console.error(`[Hit 5 / WA Lotto Live Scraper Failed for ${cfg.label}]:`, errors.join('; '));
  }
  return [];
}

/* Official walottery.com past-drawings feed: direct first, then through relays with status code logging. */
async function fetchOfficial(cfg) {
  const directUrl = waOfficialUrl(cfg.id);
  const errors = [];

  // Try direct fetch first
  try {
    const response = await fetchWithRetryAndLogging(directUrl, {}, { maxRetries: 1, timeoutMs: 6000 });
    if (response && response.ok) {
      const text = await response.text();
      const rows = E.parseWaOfficialDraws(text, cfg);
      if (rows && rows.length) return rows;
    } else if (response) {
      errors.push(`Direct endpoint returned HTTP ${response.status} (${response.statusText})`);
    }
  } catch (err) {
    errors.push(`Direct endpoint blocked (CORS / Connection error: ${err.message})`);
  }

  // Fall through to public relays with exponential backoff
  for (let i = 0; i < CORS_RELAYS.length; i++) {
    const relayUrl = CORS_RELAYS[i](directUrl);
    try {
      const response = await fetchWithRetryAndLogging(relayUrl, {}, { maxRetries: 1, timeoutMs: 8000 });
      if (response && response.ok) {
        const text = await response.text();
        const rows = E.parseWaOfficialDraws(text, cfg);
        if (rows && rows.length) return rows;
      } else if (response) {
        errors.push(`Relay #${i + 1} returned HTTP ${response.status}`);
      }
    } catch (err) {
      errors.push(`Relay #${i + 1} exception: ${err.message}`);
    }
  }

  if (errors.length) {
    console.error(`[Official WA Feed Failed for ${cfg.label}]:`, errors.join('; '));
  }
  return [];
}

/* Fetch new draws from reliable APIs, normalize into { draw_date, winning_numbers, bonus_numbers, jackpot_amount },
   and insert into dedicated table with automatic duplicate prevention. */
async function fetchLatest() {
  const cfg = config();
  let incoming = [];
  const logEntries = [];

  try {
    if (cfg.historyUrl) {
      const response = await fetch(cfg.historyUrl, { headers: { accept: 'application/json' } });
      if (response.ok) {
        const raw = await response.json();
        incoming = incoming.concat(E.normalizeHistory(raw, cfg));
        logEntries.push(`Bundled archive: ${incoming.length} draws loaded`);
      } else {
        logEntries.push(`Bundled archive: HTTP ${response.status}`);
      }
    }
  } catch (e) {
    logEntries.push(`Bundled archive: ${e.message}`);
  }

  if (LIVE_APIS[cfg.id]) {
    try {
      const response = await fetchWithRetryAndLogging(LIVE_APIS[cfg.id], { headers: { accept: 'application/json' } });
      if (response && response.ok) {
        const raw = await response.json();
        const norm = E.normalizeHistory(raw, cfg);
        incoming = incoming.concat(norm);
        logEntries.push(`NY Socrata API: ${norm.length} draws received`);
      } else if (response) {
        logEntries.push(`NY Socrata API: HTTP ${response.status} (${response.statusText})`);
      }
    } catch (e) {
      logEntries.push(`NY Socrata API: ${e.message}`);
    }
  }

  if (WA_OFFICIAL[cfg.id]) {
    try {
      const officialRows = await fetchOfficial(cfg);
      if (officialRows.length) {
        incoming = incoming.concat(officialRows);
        logEntries.push(`WA Official feed: ${officialRows.length} draws parsed`);
      }
    } catch (e) {
      logEntries.push(`WA Official feed: ${e.message}`);
    }
  }

  if (LIVE_PAGES[cfg.id]) {
    try {
      const liveRows = await fetchLivePage(LIVE_PAGES[cfg.id], cfg);
      if (liveRows.length) {
        incoming = incoming.concat(liveRows);
        logEntries.push(`Live Page Scraper: ${liveRows.length} draws parsed`);
      }
    } catch (e) {
      logEntries.push(`Live Page Scraper: ${e.message}`);
    }
  }

  if (!incoming.length && !records.length) {
    const errorMsg = `Unable to fetch ${cfg.label} data. Diagnostics:\n${logEntries.join('\n')}`;
    console.error(errorMsg);
    throw new Error(`Could not fetch ${cfg.label} draw data. Please check connection.`);
  }

  // Deduplicate and insert into dedicated centralized table
  const added = await LottoStore.insertDraws(cfg.id, incoming);
  records = await LottoStore.getDraws(cfg.id);
  winnerIndex = E.buildWinnerIndex(records);
  refresh();
  return added;
}

function isStale() {
  if (!records.length) return true;
  const newest = new Date(`${records[0].drawDate}T00:00:00`);
  if (Number.isNaN(newest.valueOf())) return true;
  return (Date.now() - newest.valueOf()) / 86400000 > (STALE_DAYS[currentGame] || 3);
}

/* 24-Hour Automated Synchronization Engine:
   Queries reliable APIs every 24h, validates against existing records to prevent duplicates,
   and updates local storage automatically. */
async function autoUpdate(force = false) {
  const cfg = config();
  const due = force || isStale() || await LottoStore.isSyncDue(currentGame);
  if (!due && records.length) {
    const meta = await LottoStore.getSyncMeta(currentGame);
    if (els.liveSyncText) {
      const timeStr = meta.lastSync ? new Date(meta.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active';
      els.liveSyncText.textContent = `Live Draw Sync: Active · Synced ${timeStr}`;
    }
    return;
  }
  if (els.liveSyncText) {
    els.liveSyncText.textContent = `Live Draw Sync: Checking 24h update (${cfg.label})...`;
  }
  try {
    const added = await fetchLatest();
    const meta = await LottoStore.getSyncMeta(currentGame);
    const timeStr = meta.lastSync ? new Date(meta.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active';
    if (els.liveSyncText) {
      els.liveSyncText.textContent = `Live Draw Sync: Active · Synced ${timeStr}`;
    }
    if (added > 0) {
      showToast(`Auto-sync: Added ${added} new official draw${added === 1 ? '' : 's'} for ${cfg.label}.`);
      announceTicketHit(records.slice(0, added));
    }
  } catch {
    if (els.liveSyncText) {
      els.liveSyncText.textContent = `Live Draw Sync: Active (${records[0]?.drawDate || 'Cached'})`;
    }
  }
}

function setRecords(newRecords) {
  records = newRecords;
  winnerIndex = E.buildWinnerIndex(records);
  save();
}

/* ---------- Render ---------- */

function refresh() {
  const cfg = config();
  latestAnalysis = E.getAnalysis(records, cfg);
  const analysis = latestAnalysis;
  drawnWhiteSet = new Set(records.flatMap((row) => row.numbers));
  drawnBonusSet = new Set(records.map((row) => row.megaBall));
  const total = cfg.totalCombinations;
  const uniqueWinners = analysis.summary.uniqueWinningCombinations;
  const latest = analysis.summary.latestDraw;

  document.title = `${cfg.label} Dashboard`;
  document.body.classList.toggle('no-bonus', !bonusOn());
  els.appTitle.textContent = cfg.label;
  els.totalMetricLabel.textContent = `Total Possible ${cfg.label} Combinations`;
  els.totalPossible.textContent = formatNumber(total);
  els.ruleDescription.textContent = bonusOn()
    ? `${cfg.whitePick} white balls ${cfg.minNumber}-${cfg.whiteMax} + ${cfg.ballLabel} 1-${cfg.megaMax}`
    : cfg.ordered
      ? `${cfg.whitePick} digits ${cfg.minNumber}-${cfg.whiteMax}, order matters, repeats allowed`
      : `${cfg.whitePick} white balls ${cfg.minNumber}-${cfg.whiteMax} (no bonus ball)`;
  els.historyCount.textContent = formatNumber(records.length);
  els.coverageLabel.textContent = analysis.meta.sourceCoverage;
  els.remainingCount.textContent = formatNumber(total - uniqueWinners);
  els.latestDrawDate.textContent = latest?.drawDate || 'No draw';
  els.latestDrawNumbers.textContent = latest
    ? `${latest.numbers.join(' · ')}${bonusOn() ? ` + ${latest.megaBall}` : ''}`
    : 'Tap "Update Draws"';
  els.freshness.textContent = records.length
    ? `${formatNumber(records.length)} draws · ${analysis.meta.sourceCoverage} · ${lastUpdatedLabel()}`
    : 'No draw history loaded yet';
  renderLookupFields(cfg);
  refreshLookupColors();
  document.querySelectorAll('.bonus-header').forEach((h) => { h.textContent = cfg.ballLabel; });
  els.megaHeatTitle.textContent = cfg.ballLabel;
  els.dataStatus.textContent = records.length
    ? `${formatNumber(records.length)} draws saved in this browser · ${analysis.meta.sourceCoverage} · ${lastUpdatedLabel()}`
    : 'No data loaded yet. Tap "Fetch Latest Draws".';
  els.methodologyText.textContent = bonusOn()
    ? `${cfg.label}: ${cfg.whitePick} white balls from ${cfg.minNumber}-${cfg.whiteMax} plus ${cfg.ballLabel} 1-${cfg.megaMax}. Remaining combinations exclude ${formatNumber(uniqueWinners)} loaded jackpot winners. All statistics describe past draws only - every drawing is random and independent.`
    : `${cfg.label}: ${cfg.ordered ? `${cfg.whitePick} ordered digits` : `${cfg.whitePick} numbers`} from ${cfg.minNumber}-${cfg.whiteMax}, no bonus ball. Remaining combinations exclude ${formatNumber(uniqueWinners)} loaded jackpot winners. All statistics describe past draws only - every drawing is random and independent.`;

  renderInsights(analysis.insights);
  renderAnalyzer(analysis);
  renderHistory();
  renderTickets();
  renderNotifStatus();
  renderDataHealth();
  loadRemaining(0);
  loadPredictions();
}

function renderInsights(insights) {
  els.insightGrid.innerHTML = insights.slice(0, 6).map((item) => `
    <article><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></article>
  `).join('');
}

function heatValue(item) {
  if (heatmapModeValue === 'recent') return item.recentCount || 0;
  if (heatmapModeValue === 'cold') return item.drawsSinceSeen ?? 0;
  return item.count || 0;
}

function renderHeatmap(container, items) {
  const values = items.map(heatValue);
  const max = Math.max(...values, 1);
  container.innerHTML = items.map((item) => {
    const value = heatValue(item);
    const intensity = value / max;
    const color = heatmapModeValue === 'cold'
      ? `rgba(143, 123, 255, ${0.08 + intensity * 0.75})`
      : `rgba(245, 197, 66, ${0.06 + intensity * 0.8})`;
    const title = `#${item.number} · ${item.count} hits · ${item.recentCount} recent · gap ${item.drawsSinceSeen ?? '-'} draws`;
    return `<div class="heat-cell" style="background:${color}" title="${escapeHtml(title)}"><b>${item.number}</b><i>${value}</i></div>`;
  }).join('');
}

function renderAnalyzer(analysis) {
  const labels = { hot: 'total frequency', recent: 'hits in last 50 draws', cold: 'draws since last seen' };
  els.legendNote.textContent = `Cell value = ${labels[heatmapModeValue]}.`;
  els.heatmapTitle.textContent = config().ordered
    ? `Digits ${config().minNumber}-${config().whiteMax}`
    : `White Balls ${config().minNumber}-${config().whiteMax}`;
  renderHeatmap(els.whiteHeatmap, analysis.frequency.white);
  renderHeatmap(els.megaHeatmap, analysis.frequency.mega);

  const topWhite = [...analysis.frequency.white].sort((a, b) => b.count - a.count).slice(0, 15);
  const maxCount = topWhite[0]?.count || 1;
  els.whiteFreqChart.innerHTML = topWhite.map((item) => barRow(`#${item.number}`, item.count, maxCount)).join('');

  const sumBuckets = analysis.distributions.sumBuckets || [];
  const maxSum = Math.max(...sumBuckets.map((b) => b.value), 1);
  els.sumChart.innerHTML = sumBuckets.map((bucket) => `
    <div class="col" title="${escapeHtml(bucket.label)}: ${bucket.value} draws">
      <div class="col-fill" style="height:${Math.max(2, (bucket.value / maxSum) * 100)}%"></div>
      <span class="lbl">${escapeHtml(bucket.label.split('-')[0])}</span>
    </div>
  `).join('');

  const oddEven = analysis.distributions.oddEven || [];
  const maxOdd = Math.max(...oddEven.map((b) => b.value), 1);
  els.oddEvenChart.innerHTML = oddEven.map((b) => barRow(b.label.replace(' odd / ', 'o/').replace(' even', 'e'), b.value, maxOdd, true)).join('');

  const lowHigh = analysis.distributions.lowHigh || [];
  const maxLow = Math.max(...lowHigh.map((b) => b.value), 1);
  els.lowHighChart.innerHTML = lowHigh.map((b) => barRow(b.label.replace(' low / ', 'L/').replace(' high', 'H'), b.value, maxLow, true)).join('');

  els.pairsList.innerHTML = (analysis.frequency.topPairs || []).slice(0, 8).map((item) => `
    <div class="pair-row"><span class="mono">${escapeHtml(item.pair)}</span><em>&times;${item.count}</em></div>
  `).join('');
}

function barRow(label, value, max, gold = false) {
  const width = Math.max(1.5, (value / max) * 100);
  return `
    <div class="bar-row">
      <span class="lbl">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill${gold ? ' gold' : ''}" style="width:${width}%"></div></div>
      <span class="val">${formatNumber(value)}</span>
    </div>`;
}

/* ---------- Predictor ---------- */

function loadPredictions() {
  if (!records.length) {
    els.predictionNotice.textContent = 'Load draw history first (tap "Update Draws" in the top bar), then picks will appear here.';
    els.predictionCards.innerHTML = '';
    els.patternSummary.innerHTML = '';
    els.predictionMethod.innerHTML = '';
    renderStrategyPicker(Object.values(E.STRATEGIES), E.STRATEGIES[currentStrategy] || E.STRATEGIES.balanced);
    return;
  }
  els.predictionNotice.textContent = 'Scoring remaining combinations with Balance strategy...';
  // Loading animation: show 3 skeleton cards on first load.
  els.predictionCards.classList.add('updating');
  if (!els.predictionCards.querySelector('.pick-card')) {
    els.predictionCards.innerHTML = Array.from({ length: 3 }, () => `
      <article class="pick-card skeleton">
        <div class="sk-line short"></div>
        <div class="sk-balls"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="sk-line"></div>
        <div class="sk-line"></div>
        <div class="sk-line short"></div>
      </article>`).join('');
  }
  // Let the animation play before the computation renders.
  setTimeout(() => {
    try {
      const data = E.getPredictions(records, winnerIndex, config(), 'balanced', predictionSalt);
      renderStrategyPicker(data.strategies, data.strategy);
      renderPredictions(data);
    } catch (error) {
      els.predictionNotice.textContent = `Prediction engine error: ${error.message}`;
    } finally {
      els.predictionCards.classList.remove('updating');
    }
  }, 500);
}

function renderStrategyPicker(strategies, active) {
  const list = strategies && strategies.length ? strategies : [E.STRATEGIES.balanced];
  const current = active || E.STRATEGIES.balanced;
  els.strategyPicker.innerHTML = list.map((s) => `
    <button class="seg-btn active" data-strategy="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>
  `).join('');
  els.strategyTagline.textContent = current.tagline;
}

function renderPredictions(data) {
  latestPredictions = data.suggestions || [];
  els.predictionNotice.textContent = `${data.disclaimer} Evaluated ${formatNumber(data.candidatesEvaluated)} candidate tickets from ${formatNumber(data.sourceDraws)} loaded draws.`;
  const p = data.patterns;
  els.patternSummary.innerHTML = `
    <div><span>Average white-ball sum</span><strong>${escapeHtml(p.averageSum)} &plusmn; ${escapeHtml(p.sumStdDev)}</strong></div>
    <div><span>Most common odd/even</span><strong>${escapeHtml(p.strongestOddEvenPattern || 'N/A')}</strong></div>
    <div><span>Most common low/high</span><strong>${escapeHtml(p.strongestLowHighPattern || 'N/A')}</strong></div>
    <div><span>Hot white balls (all time)</span><strong>${escapeHtml(p.hottestWhiteNumbers.slice(0, 8).join(', '))}</strong></div>
    <div><span>Hot white balls (recent form)</span><strong>${escapeHtml((p.hottestRecentWhiteNumbers || []).slice(0, 8).join(', '))}</strong></div>
    <div><span>Longest white gaps</span><strong>${escapeHtml(p.longestWhiteGaps.slice(0, 8).join(', '))}</strong></div>
    ${bonusOn() ? `<div><span>Hot ${escapeHtml(data.ballLabel)}s</span><strong>${escapeHtml(p.hottestMegaBalls.slice(0, 6).join(', '))}</strong></div>` : ''}
    <div><span>Strongest pairs</span><strong>${escapeHtml(p.strongestPairs.map((x) => x.pair).join(', '))}</strong></div>
  `;
  els.predictionMethod.innerHTML = data.method.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
  els.predictionCards.innerHTML = data.suggestions.map((pick) => `
    <article class="pick-card">
      <div class="pick-top">
        <span class="pick-rank">Pick ${pick.rank} · ${escapeHtml(data.strategy.label)}</span>
        <span class="pick-score" title="Pattern-match percentage: how closely this ticket matches the strategy's historical profile">${pick.score}% match</span>
      </div>
      <div class="balls">
        ${pick.numbers.map((n) => `<span class="ball">${n}</span>`).join('')}
        ${bonusBall(pick.megaBall)}
      </div>
      <div class="pick-breakdown">
        ${pick.breakdown.slice(0, 5).map((component) => `
          <div class="pb-row">
            <span>${escapeHtml(component.label)}</span>
            <div class="pb-track"><div class="pb-fill" style="width:${Math.min(100, component.value * 100)}%"></div></div>
            <span class="val">${Math.round(component.value * 100)}</span>
          </div>`).join('')}
      </div>
      <ul class="pick-notes">${pick.patternNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
      <div class="pick-meta">Remaining combo · index ${formatNumber(pick.combinationIndex)}</div>
    </article>
  `).join('');
}

/* ---------- Winners & remaining ---------- */

function renderHistory() {
  const term = els.historyFilter.value.trim().toLowerCase();
  const rows = records.filter((row) => {
    const text = `${row.drawDate} ${row.numbers.join(' ')} ${row.megaBall}`.toLowerCase();
    return !term || text.includes(term);
  });
  els.historyTable.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.drawDate || '')}${row.doublePlay ? ' <span class="dp-tag" title="Powerball Double Play draw">DP</span>' : ''}</td>
      <td><div class="balls">${row.numbers.map((n) => `<span class="ball">${n}</span>`).join('')}</div></td>
      <td class="bonus-cell">${bonusBall(row.megaBall)}</td>
      <td>${row.combinationIndex == null ? '—' : formatNumber(row.combinationIndex)}</td>
    </tr>
  `).join('');
}

function loadRemaining(after = 0) {
  const data = E.getRemaining(winnerIndex, config(), after, 100);
  latestRemaining = data;
  remainingPageAfter = after;
  els.remainingSummary.textContent = `${formatNumber(data.totalRemainingCombinations)} combinations have never won. Showing ${formatNumber(data.rows.length)} rows after index ${formatNumber(after)}.`;
  els.remainingTable.innerHTML = data.rows.map((row) => `
    <tr>
      <td>${formatNumber(row.combinationIndex)}</td>
      <td><div class="balls">${row.numbers.map((n) => `<span class="ball">${n}</span>`).join('')}</div></td>
      <td class="bonus-cell">${bonusBall(row.megaBall)}</td>
      <td>${escapeHtml(row.key)}</td>
    </tr>
  `).join('');
  els.remainingNextButton.disabled = Boolean(data.exhausted);
}

/* ---------- UI helpers ---------- */

function showTab(tabId) {
  document.querySelectorAll('.tab-button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === tabId));
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

async function withBusy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { await task(); } finally { button.disabled = false; button.textContent = original; }
}

/* ---------- Events ---------- */

document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => showTab(button.dataset.tab));
});

els.gameSwitch.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-game]');
  if (!button || button.dataset.game === currentGame) return;
  currentGame = button.dataset.game;
  saveSelectedGame();
  els.gameSwitch.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === button));
  els.searchForm.reset();
  els.searchForm.querySelectorAll('input').forEach((input) => input.classList.remove('drawn', 'never'));
  els.searchResult.className = 'result-box';
  els.searchResult.textContent = 'Enter a combination above.';
  await loadSaved();
  refresh();
  if (!records.length) doFetch();
  else autoUpdate();
});

els.heatmapMode.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  heatmapModeValue = button.dataset.mode;
  els.heatmapMode.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === button));
  if (latestAnalysis) renderAnalyzer(latestAnalysis);
});

els.strategyPicker.addEventListener('click', (event) => {
  const button = event.target.closest('[data-strategy]');
  if (!button || button.dataset.strategy === currentStrategy) return;
  currentStrategy = button.dataset.strategy;
  loadPredictions();
});

els.predictionRefreshButton.addEventListener('click', () => {
  predictionSalt = String(Date.now());
  loadPredictions();
  showToast('New picks generated.');
});

els.savePicksButton.addEventListener('click', () => {
  if (!latestPredictions.length) { showToast('Generate picks first, then save them.'); return; }
  const ticket = {
    id: `${Date.now()}`,
    game: currentGame,
    strategy: E.STRATEGIES[currentStrategy]?.label || currentStrategy,
    savedAt: new Date().toISOString(),
    picks: latestPredictions.map((p) => ({ numbers: p.numbers, megaBall: p.megaBall }))
  };
  const tickets = loadTickets();
  tickets.unshift(ticket);
  saveTickets(tickets);
  justSavedTicketId = ticket.id;
  renderTickets();
  // Save animation: button pulse + flying hearts, badge bounce (stays on this tab).
  els.savePicksButton.classList.remove('saved-pulse');
  void els.savePicksButton.offsetWidth; // restart the CSS animation
  els.savePicksButton.classList.add('saved-pulse');
  if (els.ticketBadge) {
    els.ticketBadge.classList.remove('bounce');
    void els.ticketBadge.offsetWidth;
    els.ticketBadge.classList.add('bounce');
  }
  showToast(`Saved ${ticket.picks.length} picks! See them anytime in the Tickets tab.`);
  // Ask for notification permission here (a user gesture) so match alerts can
  // reach the desktop later even when this window isn't focused.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
});

els.ticketsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-ticket]');
  if (!button) return;
  saveTickets(loadTickets().filter((t) => t.id !== button.dataset.deleteTicket));
  renderTickets();
  showToast('Ticket deleted.');
});

function renderNotifStatus() {
  if (!els.notifStatus) return;
  if (!('Notification' in window)) {
    els.notifStatus.textContent = 'This browser does not support desktop notifications.';
    return;
  }
  const labels = {
    granted: 'Desktop alerts: ON — you\'re covered.',
    denied: 'Desktop alerts: BLOCKED — enable them in your browser site settings to get jackpot alerts.',
    default: 'Desktop alerts: not enabled yet — tap the test button to allow them.'
  };
  els.notifStatus.textContent = labels[Notification.permission] || '';
}

els.testNotifButton?.addEventListener('click', async () => {
  if (!('Notification' in window)) { showToast('This browser does not support desktop notifications.'); return; }
  let permission = Notification.permission;
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { /* older browsers */ }
  }
  renderNotifStatus();
  if (permission === 'granted') {
    try {
      const note = new Notification('🎯 Test alert — lottery dashboard', {
        body: `If you can see this, desktop alerts work. You'll be notified when a saved ${config().label} ticket matches 3+ numbers.`,
        tag: 'ticket-test'
      });
      note.onclick = () => { window.focus(); showTab('ticketsTab'); };
      showToast('Test notification sent — check your desktop!');
    } catch {
      showToast('Notification was allowed but could not be shown (check OS focus settings).');
    }
  } else if (permission === 'denied') {
    showToast('Notifications are blocked. Enable them in browser site settings, then test again.');
  } else {
    showToast('Permission not granted yet.');
  }
});

function announceTicketHit(newDraws) {
  if (!newDraws || !newDraws.length) return;
  const tickets = loadTickets();
  if (!tickets.length) return;
  const cfg = config();
  const latest = newDraws[0];
  const verification = E.verifySavedTickets(tickets, latest, cfg);

  if (!verification.hasWinningMatch) return;

  const topHit = verification.highestTier;
  const isJackpot = verification.hasJackpot;
  const isTier2 = verification.hasTier2;
  const title = isJackpot
    ? '🎰 JACKPOT ALERT!'
    : isTier2
      ? '🏆 TIER 2 WINNER FLAGGED!'
      : `🎯 Lottery Win: ${topHit?.status || 'Prize Tier Matched'}!`;
  const body = isJackpot
    ? `One of your saved ${cfg.label} tickets matched EVERY winning number on ${latest.drawDate}!`
    : isTier2
      ? `A saved ${cfg.label} pick won Tier 2 ($1,000,000) on ${latest.drawDate}!`
      : `A saved ${cfg.label} pick matched ${topHit ? topHit.tierName : 'a winning prize tier'} on ${latest.drawDate}!`;

  showToast(`${title} ${body}`);

  // Desktop notification so the alert arrives even when this window isn't focused.
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const note = new Notification(title, { body, tag: `ticket-hit-${latest.drawDate}` });
      note.onclick = () => { window.focus(); showTab('ticketsTab'); };
    } catch { /* notifications blocked by the OS - toast already shown */ }
  }

  // Find winning ticket id to spotlight
  const winningTicketResult = verification.results.find((t) => t.hasWinningPick);
  if (winningTicketResult) {
    justSavedTicketId = winningTicketResult.ticketId;
  }
  renderTickets();
  setTimeout(() => {
    showTab('ticketsTab');
    const card = els.ticketsList.querySelector('.ticket-card.new, .ticket-card.has-win');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { justSavedTicketId = null; }, 6000);
  }, 1200);
}

function doFetch() {
  return withBusy(els.fetchHistoryButton, 'Fetching...', async () => {
    const added = await fetchLatest();
    showToast(added > 0
      ? `Added ${formatNumber(added)} new draw${added === 1 ? '' : 's'} (${formatNumber(records.length)} total).`
      : `Already up to date (${formatNumber(records.length)} draws).`);
    refresh();
    try { await fetchJackpots(); } catch { /* ignore jackpot refresh failures */ }
    if (added > 0) announceTicketHit(records.slice(0, added));
  }).catch((error) => showToast(`Could not fetch draws: ${error.message}`));
}

els.fetchHistoryButton.addEventListener('click', doFetch);
els.fetchHistoryButton2.addEventListener('click', doFetch);

els.exportCsvButton.addEventListener('click', () => {
  if (!records.length) { showToast('No history loaded yet.'); return; }
  const blob = new Blob([E.toCsv(records, config())], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${currentGame}_winning_numbers_history.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(`Downloaded ${formatNumber(records.length)} draws as CSV.`);
});

els.clearDataButton.addEventListener('click', () => {
  localStorage.removeItem(storageKey());
  localStorage.removeItem(updatedKey());
  loadSaved();
  refresh();
  showToast('Saved data cleared for this game.');
});

els.historyFileInput.addEventListener('change', () => {
  const file = els.historyFileInput.files[0];
  els.fileName.textContent = file ? file.name : 'Choose CSV or JSON file...';
});

function clearImportFile() {
  els.historyFileInput.value = '';
  els.fileName.textContent = 'Choose CSV or JSON file...';
}

els.uploadHistoryButton.addEventListener('click', () => withBusy(els.uploadHistoryButton, 'Importing...', async () => {
  const file = els.historyFileInput.files[0];
  if (!file) { showToast('Choose a CSV or JSON file first.'); return; }
  const content = await file.text();
  const imported = E.parseHistoryContent(content, config());
  if (!imported.length) { showToast('No valid draws found in that file.'); return; }
  const merged = E.mergeHistory(records, imported).records;
  const added = Math.max(0, merged.length - records.length);
  setRecords(merged);
  clearImportFile();
  showToast(added > 0
    ? `Imported ${formatNumber(added)} new ${config().label} draw${added === 1 ? '' : 's'}.`
    : `${config().label} import completed: no new draws were added.`);
  refresh();
}));

els.importHistoryButton.addEventListener('click', () => {
  const content = els.importText.value.trim();
  if (!content) { showToast('Paste CSV or JSON history first.'); return; }
  try {
    const imported = E.parseHistoryContent(content, config());
    if (!imported.length) { showToast('No valid draws found in the pasted text.'); return; }
    const merged = E.mergeHistory(records, imported).records;
    const added = Math.max(0, merged.length - records.length);
    setRecords(merged);
    els.importText.value = '';
    showToast(added > 0
      ? `Imported ${formatNumber(added)} new ${config().label} draw${added === 1 ? '' : 's'}.`
      : `${config().label} import completed: no new draws were added.`);
    refresh();
  } catch (error) {
    showToast(error.message);
  }
});

els.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(els.searchForm);
  const numbers = Array.from({ length: config().whitePick }, (_, i) => Number(form.get(`n${i + 1}`)));
  const mega = bonusOn() ? Number(form.get('mega')) : 1;
  try {
    const result = E.searchCombination(numbers, mega, winnerIndex, config());
    els.searchResult.className = `result-box ${result.hasWonJackpot ? 'win' : 'miss'}`;
    if (result.hasWonJackpot) {
      const dates = result.matches.map((m) => `${m.drawDate}${m.doublePlay ? ' (Double Play)' : ''}`).join(', ');
      els.searchResult.innerHTML = `<strong>Historical jackpot match.</strong><br>${escapeHtml(result.key)} won on ${escapeHtml(dates)}. Combination index ${formatNumber(result.combinationIndex)}.`;
    } else {
      els.searchResult.innerHTML = `<strong>No jackpot match in loaded history.</strong><br>${escapeHtml(result.key)} is still a remaining combination. Combination index ${formatNumber(result.combinationIndex)}.`;
    }
  } catch (error) {
    els.searchResult.className = 'result-box miss';
    els.searchResult.textContent = error.message;
  }
});

/* Build the Jackpot Lookup inputs for the active game (5+Mega, 6 numbers, 3 digits...). */
function renderLookupFields(cfg) {
  const fields = [];
  for (let i = 1; i <= cfg.whitePick; i += 1) {
    fields.push(`<input name="n${i}" type="number" min="${cfg.minNumber}" max="${cfg.whiteMax}" placeholder="—" required>`);
  }
  if (bonusOn()) {
    fields.push(`<input id="bonusInput" name="mega" type="number" min="1" max="${cfg.megaMax}" placeholder="${cfg.ballLabel === 'Powerball' ? 'PB' : 'MB'}" required class="bonus">`);
  }
  els.lookupFields.innerHTML = fields.join('');
}

/* Live red/green coloring: red = number has been drawn before, green = never drawn. */
function refreshLookupColors() {
  const cfg = config();
  els.searchForm.querySelectorAll('input[name^="n"]').forEach((input) => {
    const num = Number(input.value);
    input.classList.remove('drawn', 'never');
    if (!input.value || !Number.isInteger(num) || num < cfg.minNumber || num > cfg.whiteMax) return;
    input.classList.add(drawnWhiteSet.has(num) ? 'drawn' : 'never');
  });
  const bonusInput = $('#bonusInput');
  if (!bonusInput) return;
  const mega = Number(bonusInput.value);
  bonusInput.classList.remove('drawn', 'never');
  if (bonusInput.value && Number.isInteger(mega) && mega >= 1 && mega <= cfg.megaMax) {
    bonusInput.classList.add(drawnBonusSet.has(mega) ? 'drawn' : 'never');
  }
}

function clearLookup() {
  els.searchForm.reset();
  els.searchForm.querySelectorAll('input').forEach((input) => input.classList.remove('drawn', 'never'));
  els.searchResult.className = 'result-box';
  els.searchResult.textContent = 'Enter a combination above.';
  els.searchForm.querySelector('input')?.focus();
}

els.searchForm.addEventListener('input', refreshLookupColors);
els.clearLookupButton.addEventListener('click', clearLookup);

els.historyFilter.addEventListener('input', renderHistory);
els.remainingResetButton.addEventListener('click', () => loadRemaining(0));
els.remainingNextButton.addEventListener('click', () => loadRemaining(latestRemaining?.nextAfter || 0));

/* ---------- Init ---------- */

async function initApp() {
  loadSavedGame();
  setActiveGameButton();
  await loadSaved();
  refresh();
  renderDataHealth();
  fetchJackpots();
  if (!records.length) await doFetch();
  else await autoUpdate();
  // Check 24-hour sync status every hour
  setInterval(() => autoUpdate(false), 60 * 60 * 1000);
}

initApp();
