'use strict';
/* LottoEngine — pure client-side analysis & prediction engine.
   No server required: everything runs in the browser. */
(function (globalScope) {

  const WHITE_PICK = 5;

  function nCr(n, r) {
    if (r < 0 || r > n) return 0;
    let result = 1;
    for (let i = 1; i <= r; i += 1) result = (result * (n - r + i)) / i;
    return Math.round(result);
  }

  const GAME_CONFIGS = {
    mega: {
      id: 'mega',
      label: 'Mega Millions',
      whiteMax: 70,
      megaMax: 24,
      ballLabel: 'Mega Ball',
      historyUrl: 'mega_history.json', // bundled full archive (2002-present); live NY open-data merged on top
      statsSince: '2017-10-31' // current 5/70 matrix era; older draws kept for lookup but excluded from stats
    },
    powerball: {
      id: 'powerball',
      label: 'Powerball',
      whiteMax: 69,
      megaMax: 26,
      ballLabel: 'Powerball',
      historyUrl: 'powerball_history.json', // bundled archive (2010-present); live NY open-data merged on top
      statsSince: '2015-10-07', // current 5/69 + 1/26 matrix era; older draws kept for lookup but excluded from stats
      doublePlayField: 'double_play_winning_numbers' // NY Open Data includes Double Play draws
    },
    hit5: {
      id: 'hit5',
      label: 'Hit 5',
      whiteMax: 42,
      megaMax: 1, // Hit 5 (Washington) has no bonus ball; constant 1 keeps math uniform.
      hasBonus: false,
      ballLabel: 'Bonus',
      historyUrl: 'hit5_history.json' // bundled with the app
    },
    walotto: {
      id: 'walotto',
      label: 'Washington Lotto',
      whitePick: 6,
      whiteMax: 49,
      megaMax: 1,
      hasBonus: false,
      ballLabel: 'Bonus',
      historyUrl: 'walotto_history.json' // bundled with the app
    }
  };
  for (const config of Object.values(GAME_CONFIGS)) {
    config.whitePick = config.whitePick || WHITE_PICK;
    config.minNumber = config.minNumber ?? 1;
    config.allowRepeat = config.allowRepeat === true;
    config.ordered = config.ordered === true;
    const span = config.whiteMax - config.minNumber + 1;
    config.totalWhiteCombinations = config.allowRepeat
      ? span ** config.whitePick
      : nCr(config.whiteMax - config.minNumber + 1, config.whitePick);
    config.totalCombinations = config.totalWhiteCombinations * config.megaMax;
  }

  const keyFor = (numbers, megaBall) => `${numbers.join('-')}+${megaBall}`;

  function validateCombination(numbers, megaBall, config) {
    const pick = config.whitePick || 5;
    const min = config.minNumber ?? 1;
    if (!Array.isArray(numbers) || numbers.length !== pick) throw new Error(`Enter exactly ${pick} numbers.`);
    const normalized = config.ordered ? numbers.map(Number) : numbers.map(Number).sort((a, b) => a - b);
    if (normalized.some((n) => !Number.isInteger(n) || n < min || n > config.whiteMax)) {
      throw new Error(`Numbers must be integers from ${min} to ${config.whiteMax}.`);
    }
    if (!config.allowRepeat && new Set(normalized).size !== pick) throw new Error('Numbers must be unique.');
    const mega = Number(megaBall);
    if (!Number.isInteger(mega) || mega < 1 || mega > config.megaMax) {
      throw new Error(`${config.ballLabel} must be an integer from 1 to ${config.megaMax}.`);
    }
    return { numbers: normalized, megaBall: mega };
  }

  function whiteCombinationRank(numbers, config) {
    if (config.allowRepeat || config.ordered) {
      const span = config.whiteMax - config.minNumber + 1;
      let rank = 0;
      for (const n of numbers) rank = rank * span + (n - config.minNumber);
      return rank;
    }
    const combo = [...numbers].sort((a, b) => a - b);
    let rank = 0;
    let previous = 0;
    for (let i = 0; i < combo.length; i += 1) {
      const current = combo[i];
      const remaining = config.whitePick - i - 1;
      for (let candidate = previous + 1; candidate < current; candidate += 1) {
        rank += nCr(config.whiteMax - candidate, remaining);
      }
      previous = current;
    }
    return rank;
  }

  function combinationIndex(numbers, megaBall, config) {
    const valid = validateCombination(numbers, megaBall, config);
    return whiteCombinationRank(valid.numbers, config) * config.megaMax + valid.megaBall;
  }

  function whiteCombinationAtRank(rank, config) {
    if (config.allowRepeat || config.ordered) {
      const span = config.whiteMax - config.minNumber + 1;
      const out = new Array(config.whitePick);
      let remaining = rank;
      for (let i = config.whitePick - 1; i >= 0; i -= 1) {
        out[i] = (remaining % span) + config.minNumber;
        remaining = Math.floor(remaining / span);
      }
      return out;
    }
    const numbers = [];
    let previous = 0;
    let remainingRank = rank;
    for (let i = 0; i < config.whitePick; i += 1) {
      const remaining = config.whitePick - i - 1;
      for (let candidate = previous + 1; candidate <= config.whiteMax; candidate += 1) {
        const withCandidate = nCr(config.whiteMax - candidate, remaining);
        if (remainingRank >= withCandidate) remainingRank -= withCandidate;
        else { numbers.push(candidate); previous = candidate; break; }
      }
    }
    return numbers;
  }

  function combinationAtIndex(index, config) {
    const zeroBased = index - 1;
    const whiteRank = Math.floor(zeroBased / config.megaMax);
    const megaBall = (zeroBased % config.megaMax) + 1;
    return {
      numbers: whiteCombinationAtRank(whiteRank, config),
      megaBall,
      combinationIndex: index,
      masterCsvLine: index + 1
    };
  }

  /* ---------- History parsing ---------- */

  function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) { values.push(current); current = ''; }
      else current += char;
    }
    values.push(current);
    return values;
  }

  function parseCsv(content) {
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = parseCsvLine(lines[0]).map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    });
  }

  function pickNumberSeries(row, seriesList) {
    for (const keys of seriesList) {
      if (keys.every((key) => row[key] !== undefined && row[key] !== '')) {
        return keys.map((key) => Number(row[key]));
      }
    }
    return [];
  }

  function normalizeHistoryRow(row, config) {
    const pick = config.whitePick || 5;
    const lower = {};
    for (const [key, value] of Object.entries(row)) {
      lower[key.trim().toLowerCase().replace(/\s+/g, '_')] = value;
    }
    const drawDate = lower.draw_date || lower.date || lower.drawdate || lower.drawn_at || lower.draw;
    let numbers = [];
    let megaBall = NaN;

    if (Array.isArray(lower.numbers)) {
      numbers = lower.numbers.map(Number);
    } else if (lower.winning_numbers) {
      const parsed = String(lower.winning_numbers).match(/\d+/g)?.map(Number) || [];
      numbers = parsed.slice(0, pick);
      if (parsed.length > pick) megaBall = parsed[pick];
    } else {
      numbers = pickNumberSeries(lower, ['ball', 'num', 'n', 'ball_', 'white_', 'number_']
        .map((prefix) => Array.from({ length: pick }, (_, i) => `${prefix}${i + 1}`)));
    }
    const megaRaw = lower.mega_ball || lower.megaball || lower.mega || lower.mb || lower.bonus || lower.powerball || lower.power_ball || lower.pb;
    if (!Number.isInteger(megaBall)) megaBall = Number(String(megaRaw || '').match(/\d+/)?.[0]);
    if (config.hasBonus === false) megaBall = 1;

    try {
      const valid = validateCombination(numbers, megaBall, config);
      const index = combinationIndex(valid.numbers, valid.megaBall, config);
      return {
        drawDate: drawDate ? String(drawDate).slice(0, 10) : '',
        numbers: valid.numbers,
        megaBall: valid.megaBall,
        key: keyFor(valid.numbers, valid.megaBall),
        combinationIndex: index,
        masterCsvLine: index + 1
      };
    } catch {
      // Legacy-era draws (e.g. Mega Millions whites 71-75 before 2017, Mega Ball 25
      // before 2025): keep them for jackpot lookup and display, but without a
      // combination index since they fall outside the current ball matrix.
      const nums = (Array.isArray(numbers) ? numbers.map(Number) : []);
      const ordered = config.ordered ? nums : [...nums].sort((a, b) => a - b);
      const mega = Number(megaBall);
      if (nums.length === pick && nums.every((n) => Number.isInteger(n) && n >= 1) && Number.isInteger(mega) && mega >= 1) {
        return {
          drawDate: drawDate ? String(drawDate).slice(0, 10) : '',
          numbers: ordered,
          megaBall: mega,
          key: keyFor(ordered, mega),
          combinationIndex: null,
          masterCsvLine: null,
          legacy: true
        };
      }
      return null;
    }
  }

  function normalizeHistory(rows, config) {
    const records = [];
    for (const row of rows) {
      const record = normalizeHistoryRow(row, config);
      if (record) records.push(record);
      // Secondary draw (e.g. Powerball Double Play): track its winning combination too.
      if (config.doublePlayField && row) {
        const dpRaw = row[config.doublePlayField];
        if (dpRaw) {
          const dpRecord = normalizeHistoryRow(
            { draw_date: row.draw_date || record?.drawDate, winning_numbers: dpRaw },
            config
          );
          if (dpRecord) {
            dpRecord.doublePlay = true;
            records.push(dpRecord);
          }
        }
      }
    }
    records.sort((a, b) => String(b.drawDate).localeCompare(String(a.drawDate)));
    return records;
  }

  function parseHistoryContent(content, config) {
  let trimmed = String(content || '').replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return normalizeHistory(Array.isArray(parsed) ? parsed : parsed.records || parsed.data || [], config);
    }
    return normalizeHistory(parseCsv(trimmed), config);
  }

  /* Merge newly fetched draws into existing history without losing anything.
     Deduped by draw date + combination, sorted newest first. */
  function mergeHistory(existing, incoming) {
    const seen = new Set(existing.map((r) => `${r.drawDate}|${r.key}`));
    const merged = [...existing];
    let added = 0;
    for (const record of incoming) {
      const id = `${record.drawDate}|${record.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(record);
      added += 1;
    }
    merged.sort((a, b) => String(b.drawDate).localeCompare(String(a.drawDate)));
    return { records: merged, added };
  }

  /* Extract draws from a loosely formatted results page (dates + drawn numbers).
     Used for games without an open-data API (Hit 5, WA Lotto, Pick 3). */
  function parseLooseDrawText(text, config) {
    const pick = config.whitePick || 5;
    const sep = config.allowRepeat ? '[\s,\u2013-]+' : '\s*,\s*';
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
    const re = new RegExp(
      `(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\D{0,40}?(\d{1,2}(?:${sep}\d{1,2}){${pick - 1}})(?!${sep}\d)`,
      'g'
    );
    const rows = [];
    let match;
    while ((match = re.exec(plain))) {
      const [, mon, day, year, numsRaw] = match;
      const numbers = numsRaw.split(/[\s,\u2013-]+/).map((n) => Number(n.trim()));
      const drawDate = `${year}-${String(months[mon.toLowerCase()]).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      rows.push({ draw_date: drawDate, numbers });
    }
    return normalizeHistory(rows, config);
  }

  /* Parse draws from the official walottery.com "Past Drawings" page
     (Sun, Aug 02, 2026 + <td class="game-balls"><ul><li>..</li></ul>). */
  function parseWaOfficialDraws(text, config) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const re = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s+(\d{4})<\/p>[\s\S]{0,2000}?game-balls[\s\S]{0,200}?<ul>([\s\S]{0,4000}?)<\/ul>/g;
    const rows = [];
    let match;
    while ((match = re.exec(text))) {
      const [, , mon, day, year, block] = match;
      const numbers = [...block.matchAll(/<li>\s*(\d{1,2})\s*<\/li>/g)].map((m2) => Number(m2[1]));
      const drawDate = `${year}-${String(months[mon.toLowerCase()]).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      rows.push({ draw_date: drawDate, numbers });
    }
    return normalizeHistory(rows, config);
  }

  /* Export loaded history as a CSV that this app (and the local tool) can re-import. */
  function toCsv(records, config) {
    const hasBonus = config.hasBonus !== false;
    const header = ['draw_date', ...Array.from({ length: config.whitePick || 5 }, (_, i) => `ball${i + 1}`)];
    if (hasBonus) header.push('mega_ball');
    const lines = [header.join(',')];
    for (const record of records) {
      const row = [record.drawDate, ...record.numbers];
      if (hasBonus) row.push(record.megaBall);
      lines.push(row.join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  function buildWinnerIndex(records) {
    const index = new Map();
    for (const record of records) {
      if (!index.has(record.key)) index.set(record.key, []);
      index.get(record.key).push(record);
    }
    return index;
  }

  /* ---------- Analysis ---------- */

  function mapToSeries(map, sortByKey) {
    const series = [...map.entries()].map(([label, value]) => ({ label, value }));
    if (sortByKey) return series.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return series.sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label)));
  }

  function getAnalysis(records, config) {
    // When a game's ball matrix changed historically, stats only use the current era;
    // the full archive still powers jackpot lookup / duplicate exclusion.
    const allRecords = records;
    if (config.statsSince) records = records.filter((r) => !r.legacy && r.drawDate >= config.statsSince);
    const archiveCoverage = allRecords.length
      ? `${allRecords[allRecords.length - 1].drawDate || 'Unknown'} to ${allRecords[0].drawDate || 'Unknown'}`
      : 'No history loaded';
    const min = config.minNumber ?? 1;
    const latest = records[0] || null;
    const recentWindow = Math.min(50, records.length);
    const whiteFrequency = Array.from({ length: config.whiteMax - min + 1 }, (_, i) => ({
      number: i + min, count: 0, recentCount: 0, lastDrawDate: null, drawsSinceSeen: null
    }));
    const megaFrequency = Array.from({ length: config.megaMax }, (_, i) => ({
      number: i + 1, count: 0, recentCount: 0, lastDrawDate: null, drawsSinceSeen: null
    }));
    const pairCounts = new Map();
    const sumBuckets = new Map();
    const oddEvenCounts = new Map();
    const lowHighCounts = new Map();
    let consecutiveDraws = 0;

    for (let drawIndex = 0; drawIndex < records.length; drawIndex += 1) {
      const record = records[drawIndex];
      for (const number of record.numbers) {
        const item = whiteFrequency[number - min];
        item.count += 1;
        if (drawIndex < recentWindow) item.recentCount += 1;
        if (!item.lastDrawDate) { item.lastDrawDate = record.drawDate; item.drawsSinceSeen = drawIndex; }
      }
      const megaItem = megaFrequency[record.megaBall - 1];
      megaItem.count += 1;
      if (drawIndex < recentWindow) megaItem.recentCount += 1;
      if (!megaItem.lastDrawDate) { megaItem.lastDrawDate = record.drawDate; megaItem.drawsSinceSeen = drawIndex; }

      const sorted = [...record.numbers].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const pairKey = `${sorted[i]}-${sorted[j]}`;
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        }
      }
      const sum = sorted.reduce((acc, value) => acc + value, 0);
      const bucketStart = Math.floor(sum / 25) * 25;
      const sumKey = `${bucketStart}-${bucketStart + 24}`;
      sumBuckets.set(sumKey, (sumBuckets.get(sumKey) || 0) + 1);

      const odd = sorted.filter((v) => v % 2 === 1).length;
      const oddLabel = `${odd} odd / ${config.whitePick - odd} even`;
      oddEvenCounts.set(oddLabel, (oddEvenCounts.get(oddLabel) || 0) + 1);
      const low = sorted.filter((v) => v <= (config.whiteMax + min) / 2).length;
      const lowLabel = `${low} low / ${config.whitePick - low} high`;
      lowHighCounts.set(lowLabel, (lowHighCounts.get(lowLabel) || 0) + 1);

      if (sorted.some((v, i2) => i2 > 0 && v === sorted[i2 - 1] + 1)) consecutiveDraws += 1;
    }

    // Numbers never seen get the full history length as their gap.
    for (const item of whiteFrequency) if (item.drawsSinceSeen === null) item.drawsSinceSeen = records.length;
    for (const item of megaFrequency) if (item.drawsSinceSeen === null) item.drawsSinceSeen = records.length;

    const topWhite = [...whiteFrequency].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 10);
    const coldWhite = [...whiteFrequency].sort((a, b) => b.drawsSinceSeen - a.drawsSinceSeen || a.number - b.number).slice(0, 10);
    const topMega = [...megaFrequency].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 10);
    const coldMega = [...megaFrequency].sort((a, b) => b.drawsSinceSeen - a.drawsSinceSeen || a.number - b.number).slice(0, 8);
    const topPairs = [...pairCounts.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
      .slice(0, 12);

    const consecutiveRate = records.length ? consecutiveDraws / records.length : 0;
    const averageWhiteHits = records.length ? (records.length * config.whitePick) / (config.whiteMax - min + 1) : 0;
    const sourceCoverage = archiveCoverage;

    return {
      meta: {
        gameLabel: config.label,
        ballLabel: config.ballLabel,
        ruleSet: {
          whiteBalls: `1-${config.whiteMax}`,
          whitePick: config.whitePick,
          megaBalls: `1-${config.megaMax}`,
          totalPossibleCombinations: config.totalCombinations
        },
        sourceCoverage,
        drawCount: allRecords.length
      },
      summary: {
        drawCount: records.length,
        uniqueWinningCombinations: new Set(records.map((r) => r.key)).size,
        latestDraw: latest
      },
      frequency: { white: whiteFrequency, mega: megaFrequency, topWhite, coldWhite, topMega, coldMega, topPairs },
      distributions: {
        sumBuckets: mapToSeries(sumBuckets, true),
        oddEven: mapToSeries(oddEvenCounts, false),
        lowHigh: mapToSeries(lowHighCounts, false)
      },
      insights: buildInsights({ records, topWhite, coldWhite, topMega, coldMega, topPairs, consecutiveRate, averageWhiteHits, latest, ballLabel: config.ballLabel, hasBonus: config.hasBonus !== false })
    };
  }

  function buildInsights({ records, topWhite, coldWhite, topMega, coldMega, topPairs, consecutiveRate, averageWhiteHits, latest, ballLabel, hasBonus = true }) {
    if (!records.length) {
      return [{ title: 'Load historical draws', body: 'Use the Data tab to fetch or import draw history and populate the analyzer.' }];
    }
    const hotWhite = topWhite[0];
    const overdueWhite = coldWhite[0];
    const hotMega = topMega[0];
    const overdueMega = coldMega[0];
    const topPair = topPairs[0];
    return [
      { title: 'Most frequent white ball', body: `${hotWhite.number} has appeared ${hotWhite.count} times vs an even-history expectation of about ${averageWhiteHits.toFixed(1)}.` },
      { title: 'Longest white-ball absence', body: `${overdueWhite.number} has not appeared for ${overdueWhite.drawsSinceSeen} draws; last seen ${overdueWhite.lastDrawDate || 'never'}.` },
      ...(hasBonus ? [{ title: `${ballLabel} concentration`, body: `${hotMega.number} leads with ${hotMega.count} appearances; ${overdueMega.number} has the longest gap at ${overdueMega.drawsSinceSeen} draws.` }] : []),
      { title: 'Most repeated pair', body: topPair ? `Pair ${topPair.pair} has appeared together ${topPair.count} times.` : 'No repeated pair data yet.' },
      { title: 'Consecutive-number pattern', body: `${(consecutiveRate * 100).toFixed(1)}% of draws include at least one consecutive white-ball pair.` },
      { title: 'Latest loaded draw', body: latest ? `${latest.drawDate}: ${latest.numbers.join(', ')} + ${latest.megaBall}.` : 'No latest draw available.' }
    ];
  }

  /* ---------- Predictor ---------- */

  const STRATEGIES = {
    balanced: {
      id: 'balanced',
      label: 'Balance',
      tagline: 'Builds statistically balanced combinations based on historical sums, odd/even ratios, low/high distribution, and number spread.',
      weights: { sum: 0.24, oddEven: 0.16, lowHigh: 0.16, spread: 0.12, decade: 0.12, frequency: 0.08, overdue: 0.08, pair: 0.04 }
    }
  };

  const SCORE_LABELS = {
    frequency: 'Hot number strength',
    megaFrequency: 'Hot bonus-ball strength',
    overdue: 'Overdue factor',
    megaOverdue: 'Overdue bonus ball',
    sum: 'Sum typicality',
    oddEven: 'Odd/even balance',
    lowHigh: 'Low/high balance',
    pair: 'Pair co-occurrence',
    spread: 'Number spread',
    decade: 'Range coverage',
    unpopular: 'Crowd avoidance'
  };

  const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

  function pairKeys(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const pairs = [];
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) pairs.push(`${sorted[i]}-${sorted[j]}`);
    }
    return pairs;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /* ---------- Prize-tier simulator & verification ----------
     Fixed-prize tables are published values; jackpots are counted separately (pari-mutuel).
     Dynamic tier matching classifies each win status: Jackpot, Tier 2, Tier 3, Partial Win. */
  const TICKET_PRICES = { mega: 5, powerball: 2, walotto: 1, hit5: 1 };

  const PRIZE_TIERS = {
    mega: [
      { match: 5, bonus: true, prize: 0, status: 'Jackpot', tierLevel: 1, tierName: 'Jackpot', label: 'Jackpot (5 + Mega Ball)' },
      { match: 5, bonus: false, prize: 1000000, status: 'Tier 2', tierLevel: 2, tierName: 'Tier 2 (Match 5)', label: '5 White Balls ($1,000,000)' },
      { match: 4, bonus: true, prize: 10000, status: 'Tier 3', tierLevel: 3, tierName: 'Tier 3 (4 + MB)', label: '4 + Mega Ball ($10,000)' },
      { match: 4, bonus: false, prize: 500, status: 'Tier 4', tierLevel: 4, tierName: 'Tier 4 (4 Whites)', label: '4 White Balls ($500)' },
      { match: 3, bonus: true, prize: 200, status: 'Tier 5', tierLevel: 5, tierName: 'Tier 5 (3 + MB)', label: '3 + Mega Ball ($200)' },
      { match: 3, bonus: false, prize: 10, status: 'Partial Win', tierLevel: 6, tierName: 'Tier 6 (3 Whites)', label: '3 White Balls ($10)' },
      { match: 2, bonus: true, prize: 10, status: 'Partial Win', tierLevel: 7, tierName: 'Tier 7 (2 + MB)', label: '2 + Mega Ball ($10)' },
      { match: 1, bonus: true, prize: 4, status: 'Partial Win', tierLevel: 8, tierName: 'Tier 8 (1 + MB)', label: '1 + Mega Ball ($4)' },
      { match: 0, bonus: true, prize: 2, status: 'Partial Win', tierLevel: 9, tierName: 'Tier 9 (MB only)', label: 'Mega Ball only ($2)' }
    ],
    powerball: [
      { match: 5, bonus: true, prize: 0, status: 'Jackpot', tierLevel: 1, tierName: 'Jackpot', label: 'Jackpot (5 + Powerball)' },
      { match: 5, bonus: false, prize: 1000000, status: 'Tier 2', tierLevel: 2, tierName: 'Tier 2 (Match 5)', label: '5 White Balls ($1,000,000)' },
      { match: 4, bonus: true, prize: 50000, status: 'Tier 3', tierLevel: 3, tierName: 'Tier 3 (4 + PB)', label: '4 + Powerball ($50,000)' },
      { match: 4, bonus: false, prize: 100, status: 'Tier 4', tierLevel: 4, tierName: 'Tier 4 (4 Whites)', label: '4 White Balls ($100)' },
      { match: 3, bonus: true, prize: 100, status: 'Tier 5', tierLevel: 5, tierName: 'Tier 5 (3 + PB)', label: '3 + Powerball ($100)' },
      { match: 3, bonus: false, prize: 7, status: 'Partial Win', tierLevel: 6, tierName: 'Tier 6 (3 Whites)', label: '3 White Balls ($7)' },
      { match: 2, bonus: true, prize: 7, status: 'Partial Win', tierLevel: 7, tierName: 'Tier 7 (2 + PB)', label: '2 + Powerball ($7)' },
      { match: 1, bonus: true, prize: 4, status: 'Partial Win', tierLevel: 8, tierName: 'Tier 8 (1 + PB)', label: '1 + Powerball ($4)' },
      { match: 0, bonus: true, prize: 4, status: 'Partial Win', tierLevel: 9, tierName: 'Tier 9 (PB only)', label: 'Powerball only ($4)' }
    ],
    walotto: [
      { match: 6, bonus: false, prize: 0, status: 'Jackpot', tierLevel: 1, tierName: 'Jackpot', label: 'Jackpot (6 numbers)' },
      { match: 5, bonus: false, prize: 1000, status: 'Tier 2', tierLevel: 2, tierName: 'Tier 2 (5 numbers)', label: '5 numbers ($1,000)' },
      { match: 4, bonus: false, prize: 30, status: 'Tier 3', tierLevel: 3, tierName: 'Tier 3 (4 numbers)', label: '4 numbers ($30)' },
      { match: 3, bonus: false, prize: 3, status: 'Partial Win', tierLevel: 4, tierName: 'Tier 4 (3 numbers)', label: '3 numbers ($3)' }
    ],
    hit5: [
      { match: 5, bonus: false, prize: 0, status: 'Jackpot', tierLevel: 1, tierName: 'Jackpot', label: 'Jackpot (5 numbers)' },
      { match: 4, bonus: false, prize: 100, status: 'Tier 2', tierLevel: 2, tierName: 'Tier 2 (4 numbers)', label: '4 numbers ($100)' },
      { match: 3, bonus: false, prize: 15, status: 'Tier 3', tierLevel: 3, tierName: 'Tier 3 (3 numbers)', label: '3 numbers ($15)' },
      { match: 2, bonus: false, prize: 1, status: 'Partial Win', tierLevel: 4, tierName: 'Tier 4 (2 numbers)', label: '2 numbers ($1)' }
    ]
  };

  function prizeFor(tiers, whites, bonusHit) {
    // Highest tier wins; tiers are listed top-down so the first match applies.
    for (const tier of tiers) {
      if (tier.match !== whites) continue;
      if (tier.bonus === bonusHit || tier.bonus == null) return tier;
    }
    return null;
  }

  /* ---------- Prize Verification Engine ----------
     Comparison function that automatically checks saved numbers against official winning numbers. */
  function verifyPickAgainstDraw(pick, draw, config) {
    if (!pick || !draw) return null;
    const cfg = config || GAME_CONFIGS.mega;
    const tiers = PRIZE_TIERS[cfg.id] || [];
    let matchedWhites = [];
    let matchedIndices = [];

    if (cfg.ordered) {
      pick.numbers.forEach((num, idx) => {
        if (draw.numbers && draw.numbers[idx] === num) {
          matchedIndices.push(idx);
          matchedWhites.push(num);
        }
      });
    } else {
      const drawSet = new Set(draw.numbers || []);
      matchedWhites = pick.numbers.filter((n) => drawSet.has(n));
    }

    const whiteMatchCount = matchedWhites.length;
    const matchedBonus = cfg.hasBonus !== false && draw.megaBall === pick.megaBall;
    const tier = prizeFor(tiers, whiteMatchCount, cfg.hasBonus === false ? false : matchedBonus);

    const isJackpot = tier?.status === 'Jackpot' || (tier && tier.tierLevel === 1);
    const isTier2 = tier?.status === 'Tier 2' || (tier && tier.tierLevel === 2);
    const isWin = Boolean(tier);

    let status = 'No Match';
    if (isJackpot) status = 'Jackpot';
    else if (isTier2) status = 'Tier 2';
    else if (tier?.status === 'Tier 3' || tier?.tierLevel === 3) status = 'Tier 3';
    else if (tier) status = tier.status || 'Partial Win';
    else if (whiteMatchCount >= 2 || (matchedBonus && whiteMatchCount >= 1)) status = 'Partial Match';

    const prize = tier?.prize || 0;
    let prizeFormatted = '$0';
    if (tier) {
      if (tier.prize === 0 && isJackpot) prizeFormatted = 'Jackpot (Pari-mutuel)';
      else if (tier.prize > 0) prizeFormatted = `$${Number(tier.prize).toLocaleString()}`;
    }

    return {
      drawDate: draw.drawDate,
      drawNumbers: draw.numbers,
      drawBonus: draw.megaBall,
      pickNumbers: pick.numbers,
      pickBonus: pick.megaBall,
      matchedWhites,
      matchedIndices,
      whiteMatchCount,
      matchedBonus,
      isWin,
      isJackpot,
      isTier2,
      tier,
      tierLevel: tier?.tierLevel || null,
      tierName: tier?.tierName || (isWin ? tier?.label : 'No Match'),
      status, // 'Jackpot', 'Tier 2', 'Tier 3', 'Partial Win', 'No Match'
      prize,
      prizeFormatted,
      label: tier?.label || (isWin ? `${whiteMatchCount} matched` : 'No Match'),
      rank: whiteMatchCount * 2 + (matchedBonus ? 1 : 0)
    };
  }

  function verifySavedTickets(tickets, latestDraw, config) {
    if (!latestDraw || !Array.isArray(tickets)) {
      return {
        totalTickets: 0,
        totalPicks: 0,
        winningPicksCount: 0,
        jackpotCount: 0,
        tier2Count: 0,
        tier3Count: 0,
        partialCount: 0,
        totalEstimatedPrize: 0,
        hasJackpot: false,
        hasTier2: false,
        hasWinningMatch: false,
        highestTier: null,
        results: []
      };
    }

    const cfg = config || GAME_CONFIGS.mega;
    let totalPicks = 0;
    let winningPicksCount = 0;
    let jackpotCount = 0;
    let tier2Count = 0;
    let tier3Count = 0;
    let partialCount = 0;
    let totalEstimatedPrize = 0;
    let highestTier = null;

    const results = tickets.map((ticket) => {
      const verifiedPicks = (ticket.picks || []).map((pick) => {
        totalPicks += 1;
        const res = verifyPickAgainstDraw(pick, latestDraw, cfg);
        if (res.isWin) {
          winningPicksCount += 1;
          totalEstimatedPrize += res.prize;
          if (res.status === 'Jackpot') jackpotCount += 1;
          else if (res.status === 'Tier 2') tier2Count += 1;
          else if (res.status === 'Tier 3') tier3Count += 1;
          else partialCount += 1;

          if (!highestTier || (res.tierLevel && res.tierLevel < (highestTier.tierLevel || 999))) {
            highestTier = res;
          }
        }
        return res;
      });

      return {
        ticketId: ticket.id,
        savedAt: ticket.savedAt,
        strategy: ticket.strategy,
        verifiedPicks,
        hasWinningPick: verifiedPicks.some((p) => p.isWin)
      };
    });

    return {
      totalTickets: tickets.length,
      totalPicks,
      winningPicksCount,
      jackpotCount,
      tier2Count,
      tier3Count,
      partialCount,
      totalEstimatedPrize,
      hasJackpot: jackpotCount > 0,
      hasTier2: tier2Count > 0,
      hasWinningMatch: winningPicksCount > 0,
      highestTier,
      results
    };
  }

  function simulatePicks(picks, records, config) {
    const tiers = PRIZE_TIERS[config.id] || [];
    const price = TICKET_PRICES[config.id] ?? 1;
    const draws = records.length;
    const lines = picks.length;
    const spent = draws * lines * price;
    const counts = new Map(); // label -> { tier, count }
    let totalWon = 0;
    let jackpots = 0;
    let best = null;
    for (const draw of records) {
      for (const pick of picks) {
        let whites;
        if (config.ordered) {
          whites = pick.numbers.filter((n, i) => draw.numbers[i] === n).length;
        } else {
          whites = pick.numbers.filter((n) => draw.numbers.includes(n)).length;
        }
        const bonusHit = config.hasBonus !== false && draw.megaBall === pick.megaBall;
        const rank = whites * 2 + (bonusHit ? 1 : 0);
        if (!best || rank > best.rank) best = { drawDate: draw.drawDate, whites, bonus: bonusHit, rank };
        const tier = prizeFor(tiers, whites, config.hasBonus === false ? false : bonusHit);
        if (!tier) continue;
        const entry = counts.get(tier.label) || { tier, count: 0 };
        entry.count += 1;
        counts.set(tier.label, entry);
        if (tier.prize === 0) jackpots += 1; else totalWon += tier.prize;
      }
    }
    return {
      draws, lines, price, spent, totalWon, jackpots,
      net: totalWon - spent,
      returnRate: spent > 0 ? totalWon / spent : 0,
      tiers: [...counts.values()].sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier)),
      best,
      hasDollarTable: tiers.length > 0
    };
  }

  /* Detect combinations crowds love to play. Same jackpot odds as any other
     ticket, but a far higher chance of SPLITTING the prize, so the predictor
     rejects them outright. */
  function crowdFlags(numbers, config) {
    const flags = [];
    if (config.ordered || config.allowRepeat) return flags; // digit games: skip crowd heuristics
    const nums = [...numbers].sort((a, b) => a - b);
    if (config.whiteMax > 31 && nums.every((n) => n <= 31)) flags.push('birthday range (all numbers 31 or below)');
    let run = 1;
    for (let i = 1; i < nums.length; i += 1) {
      run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
      if (run >= Math.min(4, nums.length)) { flags.push('long consecutive run'); break; }
    }
    const step = nums.length > 1 ? nums[1] - nums[0] : 0;
    if (step > 0 && nums.every((n, i) => i === 0 || n - nums[i - 1] === step)) flags.push('even spacing pattern');
    const lastDigits = {};
    nums.forEach((n) => { const d = n % 10; lastDigits[d] = (lastDigits[d] || 0) + 1; });
    if (Math.max(...Object.values(lastDigits)) >= Math.min(4, nums.length)) flags.push('same last-digit cluster');
    if (nums.every((n) => n % 5 === 0) || nums.every((n) => n % 7 === 0)) flags.push('multiples pattern');
    return flags;
  }

  function createPrng(seed) {
    let state = seed || 1;
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function buildPatternStats(records, config) {
    const min = config.minNumber ?? 1;
    const HALF_LIFE = 100;
    const decay = Math.pow(0.5, 1 / HALF_LIFE);
    const white = Array.from({ length: config.whiteMax - min + 1 }, (_, i) => ({ number: i + min, count: 0, weightedCount: 0, drawsSinceSeen: records.length }));
    const mega = Array.from({ length: config.megaMax }, (_, i) => ({ number: i + 1, count: 0, weightedCount: 0, drawsSinceSeen: records.length }));
    const pairCounts = new Map();
    const oddEvenCounts = new Map();
    const lowHighCounts = new Map();
    const sums = [];

    for (let drawIndex = 0; drawIndex < records.length; drawIndex += 1) {
      const record = records[drawIndex];
      const recencyWeight = Math.pow(decay, drawIndex);
      const numbers = [...record.numbers].sort((a, b) => a - b);
      sums.push(numbers.reduce((a, b) => a + b, 0));

      for (const number of numbers) {
        const item = white[number - min];
        item.count += 1;
        item.weightedCount += recencyWeight;
        if (item.drawsSinceSeen === records.length) item.drawsSinceSeen = drawIndex;
      }
      const megaItem = mega[record.megaBall - 1];
      megaItem.count += 1;
      megaItem.weightedCount += recencyWeight;
      if (megaItem.drawsSinceSeen === records.length) megaItem.drawsSinceSeen = drawIndex;

      for (let i = 0; i < numbers.length; i += 1) {
        for (let j = i + 1; j < numbers.length; j += 1) {
          const pairKey = `${numbers[i]}-${numbers[j]}`;
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        }
      }
      const odd = numbers.filter((v) => v % 2 === 1).length;
      const oddLabel = `${odd}/${config.whitePick - odd}`;
      oddEvenCounts.set(oddLabel, (oddEvenCounts.get(oddLabel) || 0) + 1);
      const low = numbers.filter((v) => v <= (config.whiteMax + min) / 2).length;
      const lowLabel = `${low}/${config.whitePick - low}`;
      lowHighCounts.set(lowLabel, (lowHighCounts.get(lowLabel) || 0) + 1);
    }

    const defaultAverage = ((1 + config.whiteMax) / 2) * config.whitePick;
    const averageSum = sums.length ? sums.reduce((a, b) => a + b, 0) / sums.length : defaultAverage;
    const variance = sums.length ? sums.reduce((acc, v) => acc + (v - averageSum) ** 2, 0) / sums.length : 2000;

    return {
      white,
      mega,
      pairCounts,
      averageSum,
      sumStdDev: Math.sqrt(variance) || 1,
      maxWhiteCount: Math.max(...white.map((i) => i.count), 1),
      maxWeightedWhite: Math.max(...white.map((i) => i.weightedCount), 1e-9),
      maxWeightedMega: Math.max(...mega.map((i) => i.weightedCount), 1e-9),
      maxWhiteGap: Math.max(...white.map((i) => i.drawsSinceSeen), 1),
      maxMegaGap: Math.max(...mega.map((i) => i.drawsSinceSeen), 1),
      topWhite: [...white].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 12),
      topRecentWhite: [...white].sort((a, b) => b.weightedCount - a.weightedCount || a.number - b.number).slice(0, 12),
      coldWhite: [...white].sort((a, b) => b.drawsSinceSeen - a.drawsSinceSeen || a.number - b.number).slice(0, 12),
      topMega: [...mega].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 8),
      coldMega: [...mega].sort((a, b) => b.drawsSinceSeen - a.drawsSinceSeen || a.number - b.number).slice(0, 8),
      topPairs: [...pairCounts.entries()].map(([pair, count]) => ({ pair, count }))
        .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair)).slice(0, 12),
      oddEvenCounts,
      lowHighCounts
    };
  }

  function strategyWhiteWeights(strategyId, stats, config) {
    const min = config.minNumber ?? 1;
    const span = config.whiteMax - min + 1;
    const weights = new Array(span).fill(1);
    for (let i = 0; i < span; i += 1) {
      const item = stats.white[i];
      if (strategyId === 'hot') weights[i] = 0.5 + (item.weightedCount / stats.maxWeightedWhite) * 3;
      else if (strategyId === 'overdue') weights[i] = 0.5 + (item.drawsSinceSeen / stats.maxWhiteGap) * 3;
      else if (strategyId === 'contrarian') {
        const coldness = 1 - item.count / stats.maxWhiteCount;
        weights[i] = (0.5 + coldness) * (item.number > 31 ? 1.5 : 0.4);
      }
    }
    return weights;
  }

  function strategyMegaWeights(strategyId, stats, config) {
    const weights = new Array(config.megaMax).fill(1);
    for (let i = 0; i < config.megaMax; i += 1) {
      const item = stats.mega[i];
      if (strategyId === 'hot') weights[i] = 0.5 + (item.weightedCount / stats.maxWeightedMega) * 3;
      else if (strategyId === 'overdue' || strategyId === 'contrarian') weights[i] = 0.5 + (item.drawsSinceSeen / stats.maxMegaGap) * 3;
    }
    return weights;
  }

  function sampleWeightedIndex(weights, random) {
    let total = 0;
    for (const weight of weights) total += weight;
    let roll = random() * total;
    for (let i = 0; i < weights.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  function sampleWeightedWhites(weights, random, config) {
    const min = config.minNumber ?? 1;
    if (config.allowRepeat) {
      // Digit games (e.g. Pick 3): positions are independent, repeats allowed, order matters.
      return Array.from({ length: config.whitePick }, () => sampleWeightedIndex(weights, random) + min);
    }
    const working = weights.slice();
    const numbers = [];
    while (numbers.length < config.whitePick) {
      const index = sampleWeightedIndex(working, random);
      working[index] = 0;
      numbers.push(index + min);
    }
    return numbers.sort((a, b) => a - b);
  }

  function sampleUniformWhites(random, config) {
    const min = config.minNumber ?? 1;
    const span = config.whiteMax - min + 1;
    if (config.allowRepeat) {
      return Array.from({ length: config.whitePick }, () => min + Math.floor(random() * span));
    }
    const numbers = new Set();
    while (numbers.size < config.whitePick) numbers.add(min + Math.floor(random() * span));
    return [...numbers].sort((a, b) => a - b);
  }

  function scoreCandidate(combo, stats, strategy, config) {
    const min = config.minNumber ?? 1;
    const numbers = combo.numbers;
    const sum = numbers.reduce((a, b) => a + b, 0);
    const odd = numbers.filter((v) => v % 2 === 1).length;
    const low = numbers.filter((v) => v <= (config.whiteMax + min) / 2).length;
    const oddLabel = `${odd}/${config.whitePick - odd}`;
    const lowLabel = `${low}/${config.whitePick - low}`;
    const decades = new Set(numbers.map((n) => Math.floor((n - min) / 10)));

    const components = {
      frequency: average(numbers.map((n) => stats.white[n - min].weightedCount / stats.maxWeightedWhite)),
      megaFrequency: stats.mega[combo.megaBall - 1].weightedCount / stats.maxWeightedMega,
      overdue: average(numbers.map((n) => stats.white[n - min].drawsSinceSeen / stats.maxWhiteGap)),
      megaOverdue: stats.mega[combo.megaBall - 1].drawsSinceSeen / stats.maxMegaGap,
      sum: Math.exp(-0.5 * ((sum - stats.averageSum) / stats.sumStdDev) ** 2),
      oddEven: (stats.oddEvenCounts.get(oddLabel) || 0) / Math.max(...stats.oddEvenCounts.values(), 1),
      lowHigh: (stats.lowHighCounts.get(lowLabel) || 0) / Math.max(...stats.lowHighCounts.values(), 1),
      pair: average(pairKeys(numbers).map((pair) => (stats.pairCounts.get(pair) || 0) / Math.max(stats.topPairs[0]?.count || 1, 1))),
      spread: Math.min(1, Math.max(0, (Math.max(...numbers) - Math.min(...numbers)) / Math.max(config.whiteMax - config.minNumber - 15, 1))),
      decade: decades.size / Math.min(config.whitePick, Math.ceil(config.whiteMax / 10)),
      unpopular: numbers.filter((n) => n > 31).length / config.whitePick
    };

    let score = 0;
    const breakdown = [];
    for (const [component, weight] of Object.entries(strategy.weights)) {
      const value = components[component] ?? 0;
      score += value * weight;
      breakdown.push({
        component,
        label: SCORE_LABELS[component] || component,
        value: Number(value.toFixed(3)),
        weight,
        contribution: Number((value * weight * 100).toFixed(1))
      });
    }
    breakdown.sort((a, b) => b.contribution - a.contribution);
    return { score, breakdown };
  }

  function explainCandidate(combo, stats, config) {
    const numbers = combo.numbers;
    const sum = numbers.reduce((a, b) => a + b, 0);
    const odd = numbers.filter((v) => v % 2 === 1).length;
    const low = numbers.filter((v) => v <= config.whiteMax / 2).length;
    const megaItem = stats.mega[combo.megaBall - 1];
    const recurring = pairKeys(numbers)
      .map((pair) => ({ pair, count: stats.pairCounts.get(pair) || 0 }))
      .sort((a, b) => b.count - a.count)[0];
    const notes = [
      `Sum ${sum} vs historical average ${stats.averageSum.toFixed(0)} (std dev ${stats.sumStdDev.toFixed(0)}).`,
      `${odd} odd / ${config.whitePick - odd} even, ${low} low / ${config.whitePick - low} high.`
    ];
    if (config.megaMax > 1) {
      notes.push(`${config.ballLabel} ${combo.megaBall}: ${megaItem.count} appearances, ${megaItem.drawsSinceSeen} draws since last seen.`);
    }
    notes.push(recurring?.count ? `Strongest internal pair ${recurring.pair} appeared ${recurring.count} times.` : 'No repeated internal pair in loaded history.');
    return notes;
  }

  function getPredictions(records, winnerIndex, config, strategyId = 'balanced', salt = '') {
    const strategy = STRATEGIES[String(strategyId).toLowerCase()] || STRATEGIES.balanced;
    // Stats respect the current ball-matrix era; exclusion still uses full history.
    const stats = buildPatternStats(config.statsSince ? records.filter((r) => !r.legacy && r.drawDate >= config.statsSince) : records, config);
    const random = createPrng(hashString(`${records.length}:${records[0]?.key || ''}:${strategy.id}:${salt}`));
    const whiteWeights = strategyWhiteWeights(strategy.id, stats, config);
    const megaWeights = strategyMegaWeights(strategy.id, stats, config);

    const seen = new Set();
    const candidates = [];
    const target = 6000;
    let attempts = 0;

    while (candidates.length < target && attempts < target * 6) {
      attempts += 1;
      const numbers = attempts % 5 === 0 ? sampleUniformWhites(random, config) : sampleWeightedWhites(whiteWeights, random, config);
      const megaBall = attempts % 5 === 0 ? 1 + Math.floor(random() * config.megaMax) : sampleWeightedIndex(megaWeights, random) + 1;
      const key = keyFor(numbers, megaBall);
      if (winnerIndex.has(key) || seen.has(key)) continue;
      if (crowdFlags(numbers, config).length) continue; // reject crowd-favorite patterns
      seen.add(key);
      const { score, breakdown } = scoreCandidate({ numbers, megaBall }, stats, strategy, config);
      candidates.push({ numbers, megaBall, key, score, breakdown });
    }

    candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

    const suggestions = [];
    // Diversity rule: picks share at most ~40% of their numbers (min 2) and never the same bonus ball.
    const maxShared = Math.max(2, Math.floor(config.whitePick * 0.4));
    for (const candidate of candidates) {
      if (suggestions.length >= 3) break;
      const overlaps = suggestions.some((existing) => {
        const shared = existing.numbers.filter((n) => candidate.numbers.includes(n)).length;
        return shared > maxShared || (config.megaMax > 1 && existing.megaBall === candidate.megaBall);
      });
      if (overlaps) continue;
      const index = combinationIndex(candidate.numbers, candidate.megaBall, config);
      suggestions.push({
        rank: suggestions.length + 1,
        numbers: candidate.numbers,
        megaBall: candidate.megaBall,
        key: candidate.key,
        score: Number((candidate.score * 100).toFixed(1)),
        combinationIndex: index,
        masterCsvLine: index + 1,
        breakdown: candidate.breakdown,
        patternNotes: explainCandidate(candidate, stats, config)
      });
    }

    return {
      disclaimer: 'Every lottery draw is random and independent - no strategy changes the odds. These picks apply transparent historical-pattern scoring to remaining combinations only.',
      strategy: { id: strategy.id, label: strategy.label, tagline: strategy.tagline },
      strategies: Object.values(STRATEGIES).map(({ id, label, tagline }) => ({ id, label, tagline })),
      method: [
        'Compute recency-weighted frequency, gap, pair, sum and balance statistics from loaded draws (half-life 100 draws).',
        `Sample ~6,000 candidate tickets guided by the "${strategy.label}" weight profile (plus 20% uniform sampling for diversity).`,
        'Exclude every combination that has already won a jackpot.',
        'Reject crowd-favorite tickets (birthday ranges, consecutive runs, even spacing, last-digit clusters, multiples) to reduce jackpot splitting.',
        'Score each candidate on 8 normalized components and blend them with the strategy weight profile.',
        `Return the top 3 with a diversity rule: picks share at most ${maxShared} numbers and never the same bonus ball.`
      ],
      ballLabel: config.ballLabel,
      sourceDraws: records.length,
      candidatesEvaluated: candidates.length,
      patterns: {
        averageSum: Number(stats.averageSum.toFixed(1)),
        sumStdDev: Number(stats.sumStdDev.toFixed(1)),
        strongestOddEvenPattern: mapToSeries(stats.oddEvenCounts, false)[0]?.label || null,
        strongestLowHighPattern: mapToSeries(stats.lowHighCounts, false)[0]?.label || null,
        hottestWhiteNumbers: stats.topWhite.map((i) => i.number),
        hottestRecentWhiteNumbers: stats.topRecentWhite.map((i) => i.number),
        longestWhiteGaps: stats.coldWhite.map((i) => i.number),
        hottestMegaBalls: stats.topMega.map((i) => i.number),
        strongestPairs: stats.topPairs.slice(0, 5)
      },
      suggestions
    };
  }

  function getRemaining(winnerIndex, config, after = 0, limit = 100) {
    const rows = [];
    let cursor = Math.max(Number(after) || 0, 0) + 1;
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    while (cursor <= config.totalCombinations && rows.length < safeLimit) {
      const combo = combinationAtIndex(cursor, config);
      const key = keyFor(combo.numbers, combo.megaBall);
      if (!winnerIndex.has(key)) rows.push({ ...combo, key });
      cursor += 1;
    }
    return {
      rows,
      nextAfter: rows.length ? rows[rows.length - 1].combinationIndex : null,
      exhausted: cursor > config.totalCombinations,
      totalRemainingCombinations: config.totalCombinations - winnerIndex.size
    };
  }

  function searchCombination(numbers, megaBall, winnerIndex, config) {
    const valid = validateCombination(numbers, megaBall, config);
    const key = keyFor(valid.numbers, valid.megaBall);
    const index = combinationIndex(valid.numbers, valid.megaBall, config);
    const matches = winnerIndex.get(key) || [];
    return {
      key,
      numbers: valid.numbers,
      megaBall: valid.megaBall,
      hasWonJackpot: matches.length > 0,
      matches,
      combinationIndex: index,
      masterCsvLine: index + 1
    };
  }

  globalScope.LottoEngine = {
    GAME_CONFIGS,
    STRATEGIES,
    keyFor,
    validateCombination,
    combinationIndex,
    combinationAtIndex,
    parseHistoryContent,
    normalizeHistory,
    mergeHistory,
    parseLooseDrawText,
    parseWaOfficialDraws,
    toCsv,
    buildWinnerIndex,
    getAnalysis,
    getPredictions,
    getRemaining,
    searchCombination,
    crowdFlags,
    simulatePicks,
    verifyPickAgainstDraw,
    verifySavedTickets,
    TICKET_PRICES,
    PRIZE_TIERS
  };

})(typeof window !== 'undefined' ? window : globalThis);
