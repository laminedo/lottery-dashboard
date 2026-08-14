'use strict';
/* LottoStore — Centralized database structure & automated data synchronization.
   Dedicated tables per active game in IndexedDB:
     - table_mega (Mega Millions)
     - table_powerball (Powerball)
     - table_hit5 (Hit 5)
     - table_walotto (Washington Lotto)
     - table_meta (Sync metadata & 24h cron tracking)
     - kv (General user preferences & saved tickets)

   Standardized record schema:
   {
     "draw_date": "YYYY-MM-DD",
     "winning_numbers": [3, 15, 24, 38, 62],
     "bonus_numbers": [14],
     "jackpot_amount": "$450,000,000"
   }
*/
(function (globalScope) {
  const DB_NAME = 'lotto-central-db';
  const DB_VERSION = 2;
  const ACTIVE_GAMES = ['mega', 'powerball', 'hit5', 'walotto'];
  const TABLE_PREFIX = 'table_';
  const META_TABLE = 'table_meta';
  const KV_TABLE = 'kv';

  let dbPromise = null;
  const memoryCache = new Map();
  const metaCache = new Map();

  function getTableName(gameId) {
    return `${TABLE_PREFIX}${gameId}`;
  }

  function normalizeRecord(raw, gameId) {
    if (!raw) return null;
    const draw_date = String(raw.draw_date || raw.drawDate || raw.date || '').trim().slice(0, 10);
    if (!draw_date || draw_date.length < 8) return null;

    let winning_numbers = [];
    if (Array.isArray(raw.winning_numbers)) {
      winning_numbers = raw.winning_numbers.map(Number);
    } else if (Array.isArray(raw.numbers)) {
      winning_numbers = raw.numbers.map(Number);
    } else if (typeof raw.winning_numbers === 'string') {
      winning_numbers = raw.winning_numbers.trim().split(/[\s,-]+/).map(Number);
    } else if (typeof raw.numbers === 'string') {
      winning_numbers = raw.numbers.trim().split(/[\s,-]+/).map(Number);
    }

    let bonus_numbers = [];
    if (Array.isArray(raw.bonus_numbers)) {
      bonus_numbers = raw.bonus_numbers.map(Number);
    } else if (raw.bonus_numbers != null && raw.bonus_numbers !== '') {
      bonus_numbers = [Number(raw.bonus_numbers)];
    } else if (raw.megaBall != null && raw.megaBall !== '') {
      bonus_numbers = [Number(raw.megaBall)];
    } else if (raw.mega_ball != null && raw.mega_ball !== '') {
      bonus_numbers = [Number(raw.mega_ball)];
    } else if (raw.bonus != null && raw.bonus !== '') {
      bonus_numbers = [Number(raw.bonus)];
    }

    winning_numbers = winning_numbers.filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
    bonus_numbers = bonus_numbers.filter((n) => Number.isInteger(n));

    const jackpot_amount = String(raw.jackpot_amount || raw.jackpot || raw.estimated_jackpot || 'N/A');

    const record = {
      draw_date,
      winning_numbers,
      bonus_numbers,
      jackpot_amount
    };

    // Forward/backward compatibility accessors
    record.drawDate = record.draw_date;
    record.numbers = record.winning_numbers;
    record.megaBall = record.bonus_numbers.length > 0 ? record.bonus_numbers[0] : 1;
    record.jackpot = record.jackpot_amount;
    record.key = `${record.winning_numbers.join('-')}+${record.megaBall}`;

    return record;
  }

  function openDb() {
    if (!('indexedDB' in globalScope)) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const request = indexedDB.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Create dedicated table object stores for each active game
            ACTIVE_GAMES.forEach((game) => {
              const table = getTableName(game);
              if (!db.objectStoreNames.contains(table)) {
                db.createObjectStore(table, { keyPath: 'draw_date' });
              }
            });
            // Metadata & KV object stores
            if (!db.objectStoreNames.contains(META_TABLE)) {
              db.createObjectStore(META_TABLE, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(KV_TABLE)) {
              db.createObjectStore(KV_TABLE);
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  const LottoStore = {
    ACTIVE_GAMES,
    normalizeRecord,

    /* ---------------- Centralized Game Table Operations ---------------- */

    /* Load all records for a game table (sorted descending by draw_date). */
    async getDraws(gameId) {
      if (memoryCache.has(gameId)) return memoryCache.get(gameId);

      const db = await openDb();
      let records = [];

      if (db) {
        records = await new Promise((resolve) => {
          try {
            const table = getTableName(gameId);
            if (!db.objectStoreNames.contains(table)) return resolve([]);
            const tx = db.transaction(table, 'readonly');
            const req = tx.objectStore(table).getAll();
            req.onsuccess = () => {
              const list = (req.result || []).map((r) => normalizeRecord(r, gameId)).filter(Boolean);
              list.sort((a, b) => (b.draw_date > a.draw_date ? 1 : b.draw_date < a.draw_date ? -1 : 0));
              resolve(list);
            };
            req.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });
      }

      // Fallback to localStorage if IndexedDB is empty or unavailable
      if (!records.length) {
        try {
          const raw = localStorage.getItem(`lotto-history-${gameId}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              records = parsed.map((r) => normalizeRecord(r, gameId)).filter(Boolean);
              records.sort((a, b) => (b.draw_date > a.draw_date ? 1 : b.draw_date < a.draw_date ? -1 : 0));
              // Migrate into IndexedDB table
              if (records.length) {
                this.insertDraws(gameId, records, false).catch(() => {});
              }
            }
          }
        } catch { /* ignore corrupted entries */ }
      }

      memoryCache.set(gameId, records);
      return records;
    },

    /* Synchronous read from in-memory cache */
    getCachedDraws(gameId) {
      return memoryCache.get(gameId) || [];
    },

    /* Insert or merge draws into the dedicated game table with deduplication by draw_date */
    async insertDraws(gameId, newDraws, updateMeta = true) {
      if (!Array.isArray(newDraws) || !newDraws.length) return 0;
      const validDraws = newDraws.map((d) => normalizeRecord(d, gameId)).filter(Boolean);
      if (!validDraws.length) return 0;

      const current = await this.getDraws(gameId);
      const existingDates = new Set(current.map((d) => d.draw_date));
      const freshDraws = validDraws.filter((d) => !existingDates.has(d.draw_date));

      // Merge into full array
      const mergedMap = new Map();
      current.forEach((d) => mergedMap.set(d.draw_date, d));
      freshDraws.forEach((d) => mergedMap.set(d.draw_date, d));
      const mergedList = Array.from(mergedMap.values());
      mergedList.sort((a, b) => (b.draw_date > a.draw_date ? 1 : b.draw_date < a.draw_date ? -1 : 0));

      memoryCache.set(gameId, mergedList);

      // Persist to IndexedDB dedicated table
      const db = await openDb();
      if (db) {
        try {
          const table = getTableName(gameId);
          if (db.objectStoreNames.contains(table)) {
            const tx = db.transaction(table, 'readwrite');
            const store = tx.objectStore(table);
            validDraws.forEach((d) => {
              // Store pure database record
              store.put({
                draw_date: d.draw_date,
                winning_numbers: d.winning_numbers,
                bonus_numbers: d.bonus_numbers,
                jackpot_amount: d.jackpot_amount
              });
            });
          }
        } catch { /* ignore */ }
      }

      // Persist fallback summary in localStorage
      try {
        localStorage.setItem(`lotto-history-${gameId}`, JSON.stringify(mergedList.slice(0, 500)));
      } catch { /* ignore storage quota */ }

      if (updateMeta) {
        await this.setSyncMeta(gameId, {
          lastSync: new Date().toISOString(),
          drawsCount: mergedList.length,
          lastDrawDate: mergedList[0]?.draw_date || null
        });
      }

      return freshDraws.length;
    },

    /* Get the latest official winning draw from a game table */
    async getLatestDraw(gameId) {
      const draws = await this.getDraws(gameId);
      return draws[0] || null;
    },

    /* ---------------- Sync & 24h Cron Tracking ---------------- */

    async getSyncMeta(gameId) {
      if (metaCache.has(gameId)) return metaCache.get(gameId);
      const db = await openDb();
      let meta = null;
      if (db) {
        meta = await new Promise((resolve) => {
          try {
            const tx = db.transaction(META_TABLE, 'readonly');
            const req = tx.objectStore(META_TABLE).get(gameId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        });
      }
      if (!meta) {
        try {
          const raw = localStorage.getItem(`lotto-meta-${gameId}`);
          if (raw) meta = JSON.parse(raw);
        } catch { /* ignore */ }
      }
      if (!meta) {
        meta = { id: gameId, lastSync: null, drawsCount: 0, lastDrawDate: null };
      }
      metaCache.set(gameId, meta);
      return meta;
    },

    async setSyncMeta(gameId, metaUpdate) {
      const current = (await this.getSyncMeta(gameId)) || { id: gameId };
      const updated = { ...current, ...metaUpdate, id: gameId };
      metaCache.set(gameId, updated);

      const db = await openDb();
      if (db) {
        try {
          const tx = db.transaction(META_TABLE, 'readwrite');
          tx.objectStore(META_TABLE).put(updated);
        } catch { /* ignore */ }
      }
      try {
        localStorage.setItem(`lotto-meta-${gameId}`, JSON.stringify(updated));
      } catch { /* ignore */ }
      return updated;
    },

    /* Returns true if more than 24 hours have passed since the last sync */
    async isSyncDue(gameId) {
      const meta = await this.getSyncMeta(gameId);
      if (!meta || !meta.lastSync) return true;
      const last = new Date(meta.lastSync).getTime();
      if (isNaN(last)) return true;
      const now = Date.now();
      const hoursSince = (now - last) / (1000 * 60 * 60);
      return hoursSince >= 24;
    },

    /* ---------------- General Key-Value Storage (Tickets/Settings) ---------------- */

    async hydrate(key) {
      let value = undefined;
      const db = await openDb();
      if (db) {
        value = await new Promise((resolve) => {
          try {
            const req = db.transaction(KV_TABLE, 'readonly').objectStore(KV_TABLE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
          } catch {
            resolve(undefined);
          }
        });
      }
      if (value === undefined) {
        try {
          const raw = localStorage.getItem(key);
          if (raw != null) {
            value = JSON.parse(raw);
            if (db) {
              const tx = db.transaction(KV_TABLE, 'readwrite');
              tx.objectStore(KV_TABLE).put(value, key);
            }
          }
        } catch { /* ignore */ }
      }
      return value === undefined ? null : value;
    },

    async set(key, value) {
      const db = await openDb();
      if (db) {
        try {
          const tx = db.transaction(KV_TABLE, 'readwrite');
          tx.objectStore(KV_TABLE).put(value, key);
        } catch { /* ignore */ }
      }
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        return false;
      }
      return true;
    },

    async remove(key) {
      const db = await openDb();
      if (db) {
        try {
          const tx = db.transaction(KV_TABLE, 'readwrite');
          tx.objectStore(KV_TABLE).delete(key);
        } catch { /* ignore */ }
      }
      try {
        localStorage.removeItem(key);
      } catch { /* ignore */ }
    }
  };

  globalScope.LottoStore = LottoStore;
})(window);
