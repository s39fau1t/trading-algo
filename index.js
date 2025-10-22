//alpaca paper trading
//key: PKEMJZFGOJ6JDHDOLOJC6PYE2D
//secret: GL3UD9kbckymMGBWF7cHvniPo8RFgENrE33BpZJWtVHz

import Ratelimiter from "./ratelimiter.js";
import readline from "node:readline";
import WebSocket from "ws"; // WebSocket for trade_updates

const API = Object.freeze({
    DOMAIN: "alpaca.markets/v2",
    KEY: "PKEMJZFGOJ6JDHDOLOJC6PYE2D",
    SECRET: "GL3UD9kbckymMGBWF7cHvniPo8RFgENrE33BpZJWtVHz",
    TRADE: "paper-api",
    DATA: "data"
});

// Replace single limiter with dual: 10 req/s and 200 req/min
const RL_PER_MIN_MAX = 200;
const RL_PER_MIN_SPAN = 60 * 1000;
const RL_PER_SEC_MAX = 10;
const RL_PER_SEC_SPAN = 1000;

const PARAMS = {
    //Interval between each iteration of the algo (ms)
    INTERVAL: 30 * 1000,
    //Max money spent per day (dollars). Set <= 0 to use full initial buying power.
    MAX_PER_DAY: 0,
    //Minimum price of a stock before consider buying it (dollars)
    MIN_PRICE: 5,
    // Single cap for both per-stock exposure and per-trade spend,
    // measured as a fraction of the day's initial buying power (e.g., 0.03 = 3%)
    MAX_TRADE_PCT_OF_INITIAL_BP: 0.03,
    //Multiplier for the amount to spend on a particular stock
    SPEND_MULT: 0.05,
    //Multiplier to calculate the take profit price for bracket orders (ask price * LIMIT_PRICE_MULT = limit_price)
    LIMIT_PRICE_MULT: 1.1,
    //Multiplier to calculate the stop price (ask price * STOP_PRICE_MULT = stop_price)
    STOP_PRICE_MULT: 0.995,
    // Fixed dollar trailing amount for trailing stop orders
    TRAILING_STOP_DOLLARS: 0.50,
    // Take profit percent above filled buy price (e.g., 5 = +5%)
    TAKE_PROFIT_PERCENT: 5,
    // Breakeven trigger: when price >= entry + delta, move stop to entry
    BREAKEVEN_TRIGGER_DELTA: 0.50,
    //Time to cancel all orders and close out of all positions (24-hr, eastern time)
    CLOSING: {
        HOURS: 15,
        MINUTES: 30
    },
    // Minutes to look back for historical price comparison
    LOOKBACK_MINUTES: 10,
    // Sell if not profitable after N minutes from entry
    NON_PROFIT_TIMEOUT_MINUTES: 10,
    // Minimum share-equivalent cap when 5% of current minute volume yields 0.
    // Set to 0 to disable the floor entirely.
    MINUTE_VOL_CAP_MIN_FLOOR_SHARES: 3,
    // Static daily universe thresholds (built once per ET day at/after 09:40)
    UNIVERSE: {
        PRICE_MIN: 5,            // dollars
        PRICE_MAX: 1000,         // dollars
        ATR_DOLLARS_MIN: 0.5,    // dollars
        ATR_LOOKBACK_DAYS: 15    // daily bars window to compute ATR14
    }
};

// Replace single limiter instance
const rateLimiterPerMinute = new Ratelimiter(RL_PER_MIN_MAX, RL_PER_MIN_SPAN);
const rateLimiterPerSecond = new Ratelimiter(RL_PER_SEC_MAX, RL_PER_SEC_SPAN);

// Add: readline interface handle
let rl = null;

// Add: OCO groups registry keyed by client_order_id prefix
const ocoGroups = new Map(); // prefix -> { symbol, ids: { stopLossOrderId, trailingStopOrderId, takeProfitOrderId }, done: boolean }
// Helper to register a group once exits are placed
function registerOCOGroup(prefix, symbol, ids) {
    ocoGroups.set(prefix, { symbol, ids, done: false });
}

// Add: Alpaca trade_updates WebSocket with auto-reconnect
function connectTradeUpdates() {
    const url = `wss://${API.TRADE}.${API.DOMAIN}/stream`;
    let ws;
    let reconnectDelay = 1000;

    const subscribe = () => {
        try {
            ws = new WebSocket(url);
        } catch (e) {
            log("WS connect error:", e?.message || e);
            return setTimeout(subscribe, Math.min(30000, reconnectDelay *= 2));
        }

        ws.on("open", () => {
            reconnectDelay = 1000;
            // Authenticate
            ws.send(JSON.stringify({
                action: "authenticate",
                data: { key_id: API.KEY, secret_key: API.SECRET }
            }));
        });

        ws.on("message", async (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            const stream = msg.stream || msg.T || msg.type || "";
            const data = msg.data || msg;
            // Handle auth/listen acks across legacy/new formats
            if (stream === "authorization" && (data.status === "authorized" || data.message === "authenticated")) {
                ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
                log("WS authorized; subscribed to trade_updates.");
                return;
            }
            if (stream === "listening") {
                // Already listening
                return;
            }
            if (stream === "trade_updates" || data?.event) {
                try {
                    const ev = data.event; // e.g., "fill", "partial_fill", "canceled", etc.
                    const order = data.order || {};
                    const cid = order.client_order_id || order.client_order_id?.toString() || "";
                    if (!cid || !cid.startsWith("oco-")) return;

                    // Expect suffix -sl | -ts | -tp
                    const prefix = cid.replace(/-(sl|ts|tp)$/, "");
                    const group = ocoGroups.get(prefix);
                    if (!group || group.done) return;

                    if (ev === "fill") {
                        const filledId = order.id;
                        const siblings = [
                            group.ids.stopLossOrderId,
                            group.ids.trailingStopOrderId,
                            group.ids.takeProfitOrderId
                        ].filter(id => id && id !== filledId);

                        if (siblings.length) {
                            log(`Trade update fill for ${order.symbol} (${cid}); canceling ${siblings.length} sibling(s).`);
                            await Promise.all(siblings.map(id =>
                                request(`orders/${id}`, API.TRADE, { method: "DELETE" }).catch(() => {})
                            ));
                        }
                        group.done = true;
                    }
                } catch (e) {
                    // swallow listener errors
                }
            }
        });

        ws.on("close", () => {
            log("WS closed. Reconnecting...");
            setTimeout(subscribe, Math.min(30000, reconnectDelay *= 2));
        });

        ws.on("error", (err) => {
            log("WS error:", err?.message || err);
            try { ws.close(); } catch {}
        });
    };

    subscribe();
}

// --- Logging helpers (ET timestamp) ---
function etNow() {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(new Date());
}
function log(...args) {
    const msg = `[${etNow()} ET] ${args.join(" ")}`;
    if (process.stdout.isTTY && rl) {
        // Clear the current input line, print log, then restore the prompt + input
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(msg);
        rl.prompt(true);
    } else {
        console.log(msg);
    }
}

// Add: runtime trading pause flag
let tradingPaused = false;
// Add: automatic off-hours guard (3:30 PM -> 9:40 AM ET)
let offHoursActive = false;
// Add: track if pause was caused by off-hours so we can auto-resume at open
let pausedByOffHours = false;

// --- Terminal countdown progress bar ---
let handle; // reuses the existing handle variable for the progress timer
let stopped = false;

function formatDuration(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function drawProgress(remaining, total, label = "Next run in") {
    // If we have an interactive prompt, avoid drawing an animated bar that overwrites input
    if (rl && process.stdout.isTTY) return;

    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;
    const barWidth = Math.max(10, Math.min(40, cols - 40));
    const ratio = Math.max(0, Math.min(1, 1 - remaining / total));
    const filled = Math.round(barWidth * ratio);
    const bar = `[${"#".repeat(filled)}${"-".repeat(barWidth - filled)}] ${Math.round(ratio * 100)}% ${label} ${formatDuration(remaining)}`;
    process.stdout.write("\r" + bar.padEnd(cols - 1));
    if (remaining <= 0) process.stdout.write("\n");
}

function waitWithProgress(totalMs, label = "Next run in") {
    return new Promise((resolve) => {
        const start = Date.now();
        clearInterval(handle);
        handle = setInterval(() => {
            const elapsed = Date.now() - start;
            const remaining = Math.max(0, totalMs - elapsed);

            if (stopped) {
                clearInterval(handle);
                if (process.stdout.isTTY && !rl) process.stdout.write("\n");
                return resolve();
            }

            // With readline active: emit a one-time status at the start; no animated bar
            if (rl && process.stdout.isTTY) {
                if (elapsed === 0) {
                    log(label, formatDuration(totalMs));
                }
            } else if (process.stdout.isTTY) {
                drawProgress(remaining, total, label);
            } else if (elapsed === 0) {
                log(label, formatDuration(totalMs));
            }

            if (remaining <= 0) {
                clearInterval(handle);
                if (process.stdout.isTTY && !rl) process.stdout.write("\n");
                resolve();
            }
        }, 250);
    });
}

// Helper: get Eastern Time parts (HH:mm:ss)
function getEasternTimeParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).formatToParts(date).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});
    return {
        hour: parseInt(parts.hour, 10),
        minute: parseInt(parts.minute, 10),
        second: parseInt(parts.second, 10)
    };
}

// New: get ET date key (YYYY-MM-DD)
function getETDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}

// New: compute regular trading start minutes in ET (market open 09:30 + LOOKBACK_MINUTES)
function getTradingStartMinutesET() {
    return 9 * 60 + 30 + (PARAMS.LOOKBACK_MINUTES || 10);
}

// New: closing minutes constant
const CLOSING_MINUTES_ET = PARAMS.CLOSING.HOURS * 60 + PARAMS.CLOSING.MINUTES;

// New: are we outside the trading window? (after 15:30 or before 9:40 ET)
function isOffHoursET() {
    const { hour, minute } = getEasternTimeParts();
    const mins = hour * 60 + minute;
    const startMins = getTradingStartMinutesET();
    return mins >= CLOSING_MINUTES_ET || mins < startMins;
}

// New: format minutes since midnight as HH:MM for logs
function formatMinutesAsHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const two = (n) => String(n).padStart(2, "0");
    return `${two(h)}:${two(m)}`;
}

function toDollars(x) {
    return Math.round(x * 100) / 100;
}

// Ensure only whole, positive quantities are used in orders
function toWholeQty(x) {
    const q = Math.floor(Number(x) || 0);
    return Number.isFinite(q) && q > 0 ? q : 0;
}

// New: compute strict share-equivalent cap from minute volume (strictly < 5%)
// For options, 1 contract = 100 share-equivalents (enforced downstream).
function computeMaxShareEquivFromMinuteVolume(minuteVolume) {
    const mv = Math.max(0, Math.floor(Number(minuteVolume) || 0));
    let v = Math.floor(mv * 0.05);
    // strictly less than 5%: subtract 1 if possible
    if (v > 0) v = v - 1;

    // Apply configurable floor if 5% resolves to 0
    const floor = toWholeQty(PARAMS.MINUTE_VOL_CAP_MIN_FLOOR_SHARES ?? 0);
    if (v <= 0 && floor > 0) {
        return floor;
    }
    return toWholeQty(v);
}

// Build URL safely; handle arrays as comma‑separated (e.g., symbols=AAPL,TSLA)
function buildURL(type, path, params = {}) {
    const url = new URL(`https://${type}.${API.DOMAIN}/${path}`);
    const qp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v == null) continue;
        if (Array.isArray(v)) {
            qp.set(k, v.join(","));
        } else {
            qp.set(k, String(v));
        }
    }
    const qs = qp.toString();
    return qs ? `${url.href}?${qs}` : url.href;
}

async function noRatelimitRequest(path, type, options) {
    const url = buildURL(type, path, options.params);
    const res = await fetch(url, {
        method: options.method,
        headers: {
            accept: "application/json",
            "APCA-API-KEY-ID": API.KEY,
            "APCA-API-SECRET-KEY": API.SECRET,
            ...(options.body ? { "content-type": "application/json" } : {})
        },
        body: options.body
    });

    // Robust response handling: surface non‑JSON bodies (e.g., HTML error pages)
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} -> ${text.slice(0,200)}`);
    }
    if (contentType.includes("application/json")) {
        return JSON.parse(text);
    }
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0,200)}`);
}

async function request(path, type, options = {
    method: "GET",
    params: {},
    body: null
}) {
    // Enforce both 10 rps and 200 rpm
    await Promise.all([rateLimiterPerSecond.consume(), rateLimiterPerMinute.consume()]);
    return await noRatelimitRequest(path, type, options);
}

// Normalize Market Data snapshots shape and batch large symbol lists to avoid URL limits
function normalizeSnapshots(resp) {
    return resp?.snapshots ?? resp ?? {};
}

// New: normalize bars response into a { [symbol]: Bar[] } map
function normalizeBarsMap(resp) {
    const out = {};
    if (!resp) return out;

    // Case 1: resp.bars is an object keyed by symbol
    if (resp.bars && typeof resp.bars === "object" && !Array.isArray(resp.bars)) {
        return resp.bars;
    }

    // Case 2: resp.bars is an array of bars with symbol field (S or symbol)
    const arr = Array.isArray(resp.bars) ? resp.bars : (Array.isArray(resp) ? resp : []);
    for (const b of arr) {
        const sym = b?.S || b?.symbol;
        if (!sym) continue;
        (out[sym] = out[sym] || []).push(b);
    }
    return out;
}

async function getStocksSnapshots(allSymbols, batchSize = 200) {
    const out = {};
    for (let i = 0; i < allSymbols.length; i += batchSize) {
        const batch = allSymbols.slice(i, i + batchSize);
        const resp = await request("stocks/snapshots", API.DATA, {
            params: {
                symbols: batch,
                feed: "iex" // use IEX to avoid recent SIP restriction
            }
        });
        Object.assign(out, normalizeSnapshots(resp));
    }
    return out;
}

// New: fetch close price approximately LOOKBACK_MINUTES ago per symbol
async function getClosePriceMinutesAgo(symbols, minutesAgo = 10, batchSize = 200) {
    const out = {};
    if (!symbols.length) return out;

    const target = Date.now() - minutesAgo * 60 * 1000;
    // Search a small window around target minute to be robust
    const start = new Date(target - 60 * 1000).toISOString();
    const end = new Date(target + 60 * 1000).toISOString();

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const resp = await request("stocks/bars", API.DATA, {
            params: {
                symbols: batch,
                timeframe: "1Min",
                start,
                end,
                feed: "iex" // use IEX to avoid recent SIP restriction
            }
        });

        const barsMap = normalizeBarsMap(resp);
        for (const sym of batch) {
            const bars = barsMap[sym] || [];
            if (!bars.length) continue;

            // Pick the bar closest to target time
            let best = null;
            let bestDiff = Infinity;
            for (const b of bars) {
                const ts = Date.parse(b.t || b.time || b.Timestamp || b.ts || b.T || "");
                if (!Number.isFinite(ts)) continue;
                const diff = Math.abs(ts - target);
                if (diff < bestDiff) {
                    best = b;
                    bestDiff = diff;
                }
            }
            if (best && best.c != null) {
                out[sym] = Number(best.c);
            }
        }
    }
    return out;
}

// Helpers for options trading
async function getNearestITMCallContract(underlying, targetPrice) {
    // Fetch active call contracts for the underlying
    const resp = await request("options/contracts", API.DATA, {
        params: {
            underlying_symbols: underlying,
            status: "active",
            type: "call",
            limit: 1000
        }
    });
    const contracts = Array.isArray(resp) ? resp : (resp.contracts || []);
    if (!contracts.length) return null;

    const now = new Date();
    // Choose the nearest expiration date not in the past
    const future = contracts
        .filter(c => c.underlying_symbol === underlying)
        .filter(c => new Date(c.expiration_date) >= now);

    if (!future.length) return null;

    const nearestDate = future
        .map(c => c.expiration_date)
        .sort((a, b) => new Date(a) - new Date(b))[0];

    const sameExpiry = future.filter(c => c.expiration_date === nearestDate);

    // Pick the call with strike <= targetPrice and closest to target (i.e., max strike <= target)
    const target = Number(targetPrice);
    const candidates = sameExpiry
        .filter(c => Number(c.strike_price) <= target);

    if (!candidates.length) return null;

    candidates.sort((a, b) => Number(b.strike_price) - Number(a.strike_price));
    return candidates[0]; // has .symbol, .strike_price, .expiration_date
}

// New: batch-resolve underlying_symbol for option contract symbols
async function getUnderlyingForOptionSymbols(symbols, batchSize = 200) {
    const out = {};
    if (!symbols?.length) return out;

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const resp = await request("options/contracts", API.DATA, {
            params: { symbols: batch }
        });
        const arr = Array.isArray(resp) ? resp : (resp.contracts || []);
        for (const c of arr) {
            if (c?.symbol && c?.underlying_symbol) {
                out[c.symbol] = c.underlying_symbol;
            }
        }
    }
    return out;
}

// New: static daily universe (rebuilt once per ET day after 09:40)
let universeToday = new Set();
let universeBuiltDayKey = null;

// New: build the daily static universe (price range, ATR)
async function buildDailyUniverse(baseSymbols) {
    const dayKey = getETDateKey();
    const startMins = getTradingStartMinutesET();
    const { hour, minute } = getEasternTimeParts();
    const nowMins = hour * 60 + minute;
    if (nowMins < startMins) return; // avoid pre-open builds

    const cfg = PARAMS.UNIVERSE;
    const set = new Set();

    // Step 1: price filter using latest snapshots
    const snaps = await getStocksSnapshots(baseSymbols);
    const priceFiltered = [];
    for (const [sym, s] of Object.entries(snaps)) {
        const ask = Number(s?.latestQuote?.ap ?? 0);
        if (!Number.isFinite(ask) || ask <= 0) continue;
        if (ask >= cfg.PRICE_MIN && ask <= cfg.PRICE_MAX) {
            priceFiltered.push(sym);
        }
    }
    if (priceFiltered.length === 0) {
        universeToday = set;
        universeBuiltDayKey = dayKey;
        log("Universe build: no symbols passed price filter.");
        return;
    }

    // Removed: ATR computation and filter. Universe is price-only.
    for (const sym of priceFiltered) {
        set.add(sym);
    }

    universeToday = set;
    universeBuiltDayKey = dayKey;
    log(`Universe built: ${set.size} symbols (price in [${cfg.PRICE_MIN}, ${cfg.PRICE_MAX}]).`);
}

// Fix: missing helper to get option multiplier
async function getOptionMultiplier(optionSymbol) {
    try {
        const resp = await request("options/contracts", API.DATA, { params: { symbols: optionSymbol } });
        const arr = Array.isArray(resp) ? resp : (resp.contracts || []);
        const found = arr.find(c => c.symbol === optionSymbol);
        const mult = Number(found?.multiplier);
        return Number.isFinite(mult) && mult > 0 ? mult : 100;
    } catch {
        return 100;
    }
}

// New: ensure the static daily universe is built once per ET trading day (at/after start time)
async function ensureUniverseBuilt(baseSymbols) {
    const dayKey = getETDateKey();
    if (universeBuiltDayKey === dayKey) return;

    const { hour, minute } = getEasternTimeParts();
    const nowMins = hour * 60 + minute;
    const startMins = getTradingStartMinutesET();

    // Do not build before the allowed trading start time (e.g., 09:40 ET)
    if (nowMins < startMins) return;

    await buildDailyUniverse(baseSymbols);
}

const assetsResp = await request("assets", API.TRADE, {
    params: {
        status: "active",
        asset_class: "us_equity"
    }
});
// Normalize possible response shapes into an array
const assets = Array.isArray(assetsResp) ? assetsResp : (assetsResp?.assets || []);
if (!Array.isArray(assets)) {
    console.error("Unexpected /v2/assets response shape:", assetsResp);
}
const symbols = assets
    .filter(asset => asset.tradable && (asset.exchange === "NYSE"))
    .map(asset => asset.symbol);

let moneySpent = 0;
// New: track day + initial buying power (ET)
let initialBuyingPower = 0;
let currentDayKey = null;
// Add: track traded symbols per day
let tradedSymbolsToday = new Set();

// Effective daily budget resolver
function getDailyBudget() {
    const cap = Number(PARAMS.MAX_PER_DAY);
    if (!Number.isFinite(cap) || cap <= 0) return toDollars(initialBuyingPower);
    // Never exceed initial buying power for the day
    return toDollars(Math.min(cap, initialBuyingPower));
}

async function ensureDayState() {
    const dayKey = getETDateKey();
    if (currentDayKey !== dayKey || !initialBuyingPower) {
        const account = await request("account", API.TRADE);
        // Use buying_power when available; fallback to cash
        initialBuyingPower = parseFloat((account.buying_power ?? account.cash) || "0");
        currentDayKey = dayKey;
        moneySpent = 0;
        tradedSymbolsToday.clear(); // Reset traded symbols on new day
        // New: reset daily universe so it rebuilds at/after 09:40 ET
        universeToday.clear();
        universeBuiltDayKey = null;
    }
}

async function cleanup() {
    clearInterval(handle);
    // Do NOT stop the loop; we keep enforcing off-hours flat state
    const { hour, minute, second } = getEasternTimeParts();
    const nowTotalSec = hour * 3600 + minute * 60 + second;
    const targetTotalSec = CLOSING_MINUTES_ET * 60;
    const waitMs = Math.max(0, (targetTotalSec - nowTotalSec) * 1000);

    log("Cleanup scheduled. Will flatten (positions first, then orders) at", `${String(PARAMS.CLOSING.HOURS).padStart(2, "0")}:${String(PARAMS.CLOSING.MINUTES).padStart(2, "0")} ET`);

    setTimeout(async () => {
        log("3:30 PM ET reached: flattening positions before canceling any open orders...");
        await flattenAndCancel();
        offHoursActive = true;
        tradingPaused = true; // remain paused until 9:40 AM ET
        log("Off-hours engaged. No positions or open orders will be allowed until market re-opens window.");
    }, waitMs);
}

// Add: wait helper to ensure positions are closed before canceling orders
async function waitForPositionsClosed(timeoutMs = 120000, pollMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const positions = await request("positions", API.TRADE);
            if (!Array.isArray(positions) || positions.length === 0) {
                return true;
            }
        } catch (e) {
            // If the endpoint errors transiently, continue polling
        }
        await new Promise(res => setTimeout(res, pollMs));
    }
    return false;
}

// Add: wait until there are no open orders
async function waitForNoOpenOrders(timeoutMs = 120000, pollMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const openOrders = await request("orders", API.TRADE, { params: { status: "open" } });
            if (!Array.isArray(openOrders) || openOrders.length === 0) {
                return true;
            }
        } catch (e) {
            // transient, continue
        }
        await new Promise(res => setTimeout(res, pollMs));
    }
    return false;
}

// Add: flatten and cancel helper (close all positions, then cancel open orders)
async function flattenAndCancel() {
    try {
        log("Flatten: closing all positions...");
        await request("positions", API.TRADE, {
            method: "DELETE",
            params: { cancel_orders: false }
        });

        // Wait until all positions are closed before canceling orders
        const closed = await waitForPositionsClosed();
        if (closed) {
            log("All positions closed.");
        } else {
            log("Timed out waiting for positions to close; proceeding to cancel open orders.");
        }
    } catch (e) {
        log("Flatten error:", e?.message || e);
    }

    try {
        log("Cancel: canceling all remaining open orders...");
        await request("orders", API.TRADE, { method: "DELETE" });
        await waitForNoOpenOrders();
        log("All open orders canceled.");
    } catch (e) {
        log("Cancel error:", e?.message || e);
    }

    log("Flatten-and-cancel complete.");
}

// Add: move stop to breakeven after $0.50 advance (equity only)
async function monitorBreakevenStop(symbol, entryPrice, stopLossOrderId) {
    try {
        const trigger = toDollars(entryPrice + (PARAMS.BREAKEVEN_TRIGGER_DELTA ?? 0.5));
        let done = false;

        while (!done) {
            // Stop if stop loss order is no longer active
            const sl = await request(`orders/${stopLossOrderId}`, API.TRADE).catch(() => null);
            if (!sl) break;

            const status = sl.status;
            const isActive = ["new", "accepted", "open", "partially_filled"].includes(status);
            if (!isActive) break;

            const currentStop = parseFloat(sl.stop_price ?? "0");
            if (currentStop >= entryPrice - 1e-6) break; // already at/above breakeven

            // Get latest equity quote (IEX)
            const quoteResp = await request("stocks/quotes/latest", API.DATA, {
                params: { symbols: symbol, feed: "iex" }
            }).catch(() => null);

            const q = quoteResp?.[symbol] || quoteResp?.latestQuote || quoteResp?.latestQuotes?.[symbol] || {};
            const px = Number(q.ap ?? q.ask_price ?? 0);

            if (px && px >= trigger) {
                // Move stop to breakeven
                await request(`orders/${stopLossOrderId}`, API.TRADE, {
                    method: "PATCH",
                    body: JSON.stringify({ stop_price: toDollars(entryPrice) })
                }).catch(() => {});
                log(`Breakeven stop set for ${symbol} at ${toDollars(entryPrice)} (triggered >= ${toDollars(trigger)})`);
                break;
            }

            await new Promise(res => setTimeout(res, 3000));
        }
    } catch {
        // swallow background errors
    }
}

// Add: place order with retries (used to ensure trailing stop gets placed)
async function placeOrderWithRetry(body, retries = 3, delayMs = 1500) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await request("orders", API.TRADE, {
                method: "POST",
                body: JSON.stringify(body)
            });
        } catch (e) {
            lastErr = e;
            if (i < retries) {
                await new Promise(res => setTimeout(res, delayMs));
            }
        }
    }
    throw lastErr || new Error("Failed to place order after retries");
}

// Add: helper to build order body (conditionally add asset_class for options)
function buildOrderBody({ symbol, qty, side, type, tif = "gtc", assetClass, extra = {} }) {
    const body = { symbol, qty, side, type, time_in_force: tif, ...extra };
    if (assetClass === "option") body.asset_class = "option";
    return body;
}

// Replace: ensure custom bracket legs include shared client_order_id prefix
async function placeCustomBracketOrders({ symbol, qty, assetClass, entryPrice, clientIdPrefix }) {
    const takeProfitPrice = toDollars(entryPrice * (1 + PARAMS.TAKE_PROFIT_PERCENT / 100));
    // Removed fixed stop; use trailing stop instead
    let trailingStopOrder, takeProfitOrder;

    try {
        trailingStopOrder = await placeOrderWithRetry(
            buildOrderBody({
                symbol, qty, side: "sell", type: "trailing_stop", assetClass,
                extra: { trail_price: toDollars(PARAMS.TRAILING_STOP_DOLLARS || 0.5), client_order_id: `${clientIdPrefix}-ts` }
            }),
            4
        );

        takeProfitOrder = await placeOrderWithRetry(
            buildOrderBody({
                symbol, qty, side: "sell", type: "limit", assetClass,
                extra: { limit_price: takeProfitPrice, client_order_id: `${clientIdPrefix}-tp` }
            })
        );

        if (!trailingStopOrder?.id) {
            throw new Error("Trailing stop placement failed");
        }
    } catch (e) {
        const ids = [trailingStopOrder?.id, takeProfitOrder?.id].filter(Boolean);
        await Promise.all(ids.map(id =>
            request(`orders/${id}`, API.TRADE, { method: "DELETE" }).catch(() => {})
        ));
        throw e;
    }

    // Keep shape for OCO tracking; stopLossOrderId is now null
    return {
        stopLossOrderId: null,
        trailingStopOrderId: trailingStopOrder.id,
        takeProfitOrderId: takeProfitOrder.id
    };
}

// Add: enforce off-hours state (flat positions, no open orders, pause trading)
async function enforceOffHours() {
    const offNow = isOffHoursET();

    if (offNow) {
        if (!offHoursActive) {
            offHoursActive = true;
            tradingPaused = true;
            pausedByOffHours = true;
            const startMins = getTradingStartMinutesET();
            log(`Off-hours detected. Trading paused until ${formatMinutesAsHHMM(startMins)} ET. Ensuring flat state...`);
        }

        try {
            const [positions, openOrders] = await Promise.all([
                request("positions", API.TRADE).catch(() => []),
                request("orders", API.TRADE, { params: { status: "open" } }).catch(() => [])
            ]);
            if ((Array.isArray(positions) && positions.length > 0) || (Array.isArray(openOrders) && openOrders.length > 0)) {
                await flattenAndCancel();
            }
        } catch (e) {
            log("Off-hours flatten error:", e?.message || e);
        }
        return true; // skip trading work in algo()
    } else {
        if (offHoursActive) {
            offHoursActive = false;
            if (pausedByOffHours) {
                tradingPaused = false;
                pausedByOffHours = false;
                log("Market window open: off-hours ended. Trading resumed.");
            } else {
                log("Market window open.");
            }
        }
        return false;
    }
}

// Track one-shot non-profit exit timers by exact traded symbol (equity or option contract)
const nonProfitWatch = new Map(); // symbol -> { dueAt, timer, assetClass }

// Cancel all open orders for a specific symbol (exits, etc.)
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        const openOrders = await request("orders", API.TRADE, { params: { status: "open" } });
        const ours = (Array.isArray(openOrders) ? openOrders : []).filter(o => o.symbol === symbol);
        await Promise.all(ours.map(o => request(`orders/${o.id}`, API.TRADE, { method: "DELETE" }).catch(() => {})));
    } catch {
        // ignore cancel errors
    }
}

// One-shot check: if 10 minutes after entry the position is not profitable, close it
async function checkAndExitNonProfit(symbol, assetClass) {
    try {
        // Clear watch on entry to avoid re-entry in case of long operations
        const watch = nonProfitWatch.get(symbol);
        if (watch) {
            clearTimeout(watch.timer);
            nonProfitWatch.delete(symbol);
        }

        // Find current position for this exact traded symbol
        const positions = await request("positions", API.TRADE).catch(() => []);
        const pos = (Array.isArray(positions) ? positions : []).find(p => p.symbol === symbol);
        if (!pos) {
            // Already exited via other exits; nothing to do
            return;
        }

        const unrealized = parseFloat(pos.unrealized_pl ?? "0");
        if (Number.isFinite(unrealized) && unrealized > 0) {
            // It produced a profit at the checkpoint; keep running
            log(`Non-profit check: ${symbol} is profitable (+${unrealized.toFixed(2)}). Holding.`);
            return;
        }

        // Not profitable: cancel exits and close position at market
        log(`Non-profit check: ${symbol} not profitable (${(unrealized || 0).toFixed(2)}). Closing position.`);
        await cancelOpenOrdersForSymbol(symbol);

        // Determine side and qty
        const qty = toWholeQty(pos.qty);
        if (qty > 0) {
            const side = pos.side === "short" ? "buy" : "sell"; // Guard, though we only open longs
            await request("orders", API.TRADE, {
                method: "POST",
                body: JSON.stringify(buildOrderBody({
                    symbol,
                    qty,
                    side,
                    type: "market",
                    tif: "day",
                    assetClass: assetClass === "option" ? "option" : undefined
                }))
            }).catch(e => log("Non-profit market close error:", e?.message || e));
        }
    } catch (e) {
        log("Non-profit check error:", e?.message || e);
    }
}

// Schedule a one-time non-profit exit check for a filled trade
function scheduleNonProfitExit({ symbol, assetClass }) {
    const minutes = PARAMS.NON_PROFIT_TIMEOUT_MINUTES ?? 10;
    const timeoutMs = Math.max(1, minutes) * 60 * 1000;
    // Cancel any prior watch for same symbol
    const prev = nonProfitWatch.get(symbol);
    if (prev) clearTimeout(prev.timer);

    const timer = setTimeout(() => {
        checkAndExitNonProfit(symbol, assetClass).catch(() => {});
    }, timeoutMs);
    nonProfitWatch.set(symbol, { dueAt: Date.now() + timeoutMs, timer, assetClass });
    log(`Scheduled non-profit exit for ${symbol} in ${minutes} min.`);
}

// Add: helper to maximize spend using options + equity legs under the same cap
// NOTE: options ignore minute-volume caps; stocks must obey them.
async function planHybrid(stock, baseCap, sharesCap, maxShareEquiv) {
    // Try to get nearest ITM call and its ask
    let contract = null;
    let optAsk = 0;
    try {
        const targetStrike = stock.ask * 0.95;
        contract = await getNearestITMCallContract(stock.symbol, targetStrike);
        if (contract?.symbol) {
            const quotes = await request("options/quotes/latest", API.DATA, { params: { symbols: contract.symbol } });
            const optQuote = quotes[contract.symbol] || quotes.latestQuote || quotes.latestQuotes?.[contract.symbol];
            optAsk = Number(optQuote?.ap ?? optQuote?.ask_price ?? 0);
        }
    } catch {
        // ignore option discovery errors
    }

    const legs = [];
    const equityUnit = Number(stock.ask) || 0;
    // Use multiplier from contract data; avoid assuming 100 for adjusted contracts
    const mult = Number(contract?.multiplier);
    const optUnit = optAsk > 0 && Number.isFinite(mult) && mult > 0 ? optAsk * mult : 0; // option notional per contract
    if (!Number.isFinite(equityUnit) || equityUnit <= 0) return legs;

    // Strict 5% minute-volume cap applies only to shares
    const volCapShares = toWholeQty(maxShareEquiv);
    if (volCapShares <= 0 && optUnit <= 0) return legs;

    // Shares-only candidate (limited by dollars and share-volume cap)
    const maxSharesByDollar = toWholeQty((sharesCap || 0) / equityUnit);
    const maxSharesByVolume = volCapShares;
    const sharesOnlyQty = Math.min(maxSharesByDollar, maxSharesByVolume);
    let bestSpend = toDollars(sharesOnlyQty * equityUnit);
    let best = { optQty: 0, shareQty: sharesOnlyQty, spend: bestSpend };

    // Options candidate(s): options are NOT volume-limited; only dollar/base caps apply
    if (optUnit > 0 && baseCap >= optUnit) {
        const maxContractsByDollar = toWholeQty(baseCap / optUnit);
        const candidates = [maxContractsByDollar, Math.max(0, maxContractsByDollar - 1), Math.max(0, maxContractsByDollar - 2)];

        for (const k of candidates) {
            const spendOpt = k * optUnit;
            const remDollar = Math.max(0, baseCap - spendOpt);

            // Shares still must obey share cap AND share-volume cap
            const sharesDollarRoom = Math.min(remDollar, sharesCap || 0);
            const sh = Math.min(toWholeQty(sharesDollarRoom / equityUnit), volCapShares);

            const spend = toDollars(spendOpt + sh * equityUnit);
            if (spend > bestSpend) {
                bestSpend = spend;
                best = { optQty: k, shareQty: sh, spend };
            }
        }
    }

    // Build legs (shares obey volume cap; options do not)
    if (best.optQty > 0 && contract?.symbol) {
        legs.push({
            symbol: contract.symbol,
            underlying: stock.symbol,
            assetClass: "option",
            qty: best.optQty,
            estSpend: toDollars(best.optQty * optUnit),
            entryAsk: optAsk,
            // carry multiplier forward for downstream sizing/accounting
            multiplier: Number.isFinite(mult) && mult > 0 ? mult : undefined
        });
    }
    if (best.shareQty > 0) {
        legs.push({
            symbol: stock.symbol,
            underlying: stock.symbol,
            assetClass: undefined,
            qty: best.shareQty,
            estSpend: toDollars(best.shareQty * equityUnit),
            entryAsk: equityUnit
        });
    }

    return legs;
}

// New: fetch latest snapshot for a single symbol (IEX)
async function getLatestSnapshot(symbol) {
    const resp = await request("stocks/snapshots", API.DATA, {
        params: { symbols: symbol, feed: "iex" }
    });
    const snaps = normalizeSnapshots(resp);
    return snaps?.[symbol] || null;
}

// New: fetch latest option ask for a single contract
async function getLatestOptionAsk(optionSymbol) {
    try {
        const quotes = await request("options/quotes/latest", API.DATA, { params: { symbols: optionSymbol } });
        const q = quotes?.[optionSymbol] || quotes?.latestQuote || quotes?.latestQuotes?.[optionSymbol] || {};
        return Number(q.ap ?? q.ask_price ?? 0) || 0;
    } catch {
        return 0;
    }
}

// New: revalidate and cap qty for a single trade right before sending the buy
// Options: only per-trade dollar cap applies (no minute-volume cap).
// Stocks: keep strict 5% minute-volume cap.
async function revalidateAndCapQtyBeforeBuy(plan, perTradeCap) {
    if (plan.assetClass === "option") {
        let ask = await getLatestOptionAsk(plan.symbol);
        if (!ask) ask = Number(plan.entryAsk || 0);

        // Ensure we use the contract's multiplier; fetch if not carried in the plan
        let mult = Number(plan.multiplier);
        if (!Number.isFinite(mult) || mult <= 0) {
            mult = await getOptionMultiplier(plan.symbol).catch(() => 100);
        }

        const unit = ask > 0 ? ask * mult : 0;
        const maxByDollar = unit > 0 ? toWholeQty(perTradeCap / unit) : 0;
        const capped = Math.min(plan.qty, maxByDollar);
        return { qty: toWholeQty(capped), latestAsk: ask, minuteVol: 0 };
    } else {
        const snap = await getLatestSnapshot(plan.symbol);
        const minuteVol = Number(snap?.minuteBar?.v ?? 0);
        const ask = Number(snap?.latestQuote?.ap ?? plan.entryAsk ?? 0);
        const volCapShares = computeMaxShareEquivFromMinuteVolume(minuteVol);
        const maxByDollar = ask > 0 ? toWholeQty(perTradeCap / ask) : 0;
        const capped = Math.min(plan.qty, volCapShares, maxByDollar);
        return { qty: toWholeQty(capped), latestAsk: ask, minuteVol };
    }
}

async function algo() {
    log("Iteration start");

    // Enforce no trading/no orders/no positions during off-hours (15:30 -> 09:40 ET)
    if (await enforceOffHours()) {
        return;
    }

    // Ensure Eastern Time for closing logic
    const { hour: etHour, minute: etMinute } = getEasternTimeParts();
    if (etHour === PARAMS.CLOSING.HOURS && etMinute + PARAMS.INTERVAL / 60 / 1000 >= PARAMS.CLOSING.MINUTES) {
        await cleanup();
    }

    // Gate: do not place trades before market open + LOOKBACK_MINUTES (e.g., 09:40 ET by default)
    const nowMins = etHour * 60 + etMinute;
    const startMins = getTradingStartMinutesET();
    if (nowMins < startMins) {
        log(`Pre-market window: trading begins at ${formatMinutesAsHHMM(startMins)} ET. Skipping orders this iteration.`);
        return;
    }

    // Guard: skip any new trades while paused
    if (tradingPaused) {
        log("Trading paused (dump active). Skipping order placement.");
        return;
    }

    await ensureDayState();

    // New: build static universe once per day
    await ensureUniverseBuilt(symbols);

    const snapshots = await getStocksSnapshots(symbols);

    // Pre-filter viable symbols using the static universe and gather for historical lookup
    const viableSymbols = [];
    for (const [symbol, snapshot] of Object.entries(snapshots)) {
        if (!universeToday.has(symbol)) continue; // New: only scan inside universe
        if (!snapshot?.minuteBar || !snapshot?.latestQuote) continue;
        const ask = snapshot.latestQuote.ap;
        if (ask < PARAMS.MIN_PRICE) continue;
        viableSymbols.push(symbol);
    }

    // Fetch prices ~LOOKBACK_MINUTES ago only for viable symbols
    const price10mAgo = await getClosePriceMinutesAgo(viableSymbols, PARAMS.LOOKBACK_MINUTES);

    const stocks = [];
    for (const symbol of viableSymbols) {
        const snapshot = snapshots[symbol];
        const ask = snapshot.latestQuote.ap;
        const prev = price10mAgo[symbol];

        if (!prev || prev <= 0) continue;

        stocks.push({
            symbol,
            ask,
            volume: snapshot.minuteBar.v,
            change: (ask - prev) / prev
        });
    }

    stocks.sort((a, b) => b.change - a.change);

    log("Candidates:", stocks.length);

    // Snapshot combined exposure (equity + options) by underlying symbol
    const positions = await request("positions", API.TRADE);
    const exposureByUnderlying = {};

    // Resolve underlying symbols for any option positions via contracts data
    const optionSymbols = [...new Set(
        (Array.isArray(positions) ? positions : [])
            .filter(p => String(p.asset_class).toLowerCase().includes("option"))
            .map(p => p.symbol)
    )];

    const optUnderMap = optionSymbols.length
        ? await getUnderlyingForOptionSymbols(optionSymbols)
        : {};

    for (const p of positions) {
        const isOption = String(p.asset_class).toLowerCase().includes("option");
        const underlying = isOption ? (optUnderMap[p.symbol] || p.symbol) : p.symbol;
        exposureByUnderlying[underlying] = (exposureByUnderlying[underlying] || 0) + parseFloat(p.market_value);
    }

    // New: per-iteration remaining allocation based on initial day BP (not current cash)
    const perTradeCap = toDollars(initialBuyingPower * PARAMS.MAX_TRADE_PCT_OF_INITIAL_BP);
    const pendingExposureByUnderlying = {};
    const usedUnderlyings = new Set(); // avoid allocating same underlying twice in the same iteration

    // Replace single-leg planner with hybrid planner to maximize spend
    const planOneHybrid = async (stock, baseCap, sharesCap) => {
        const maxShareEquiv = computeMaxShareEquivFromMinuteVolume(stock.volume);
        return await planHybrid(stock, baseCap, sharesCap, maxShareEquiv);
    };

    // Wave-based batch buying to consume remaining allocation in one iteration
    let waves = 0;
    while (true) { // keep going until budget is exhausted or no more viable plans
        // Use the effective daily budget instead of raw initialBuyingPower or static MAX_PER_DAY
        let remainingAlloc = toDollars(Math.max(0, getDailyBudget() - moneySpent - 5));
        let dailyRemainingNow = toDollars(Math.max(0, getDailyBudget() - moneySpent));
        if (remainingAlloc < PARAMS.MIN_PRICE || dailyRemainingNow < PARAMS.MIN_PRICE) break;

        const batchPlans = [];

        for (const stock of stocks) {
            // Enforce per-ticker per-day gate: skip if we already bought this underlying today
            if (tradedSymbolsToday.has(stock.symbol)) continue;

            // Allow re-trading the same symbol across iterations/day if capacity remains
            // Only avoid double planning in the same iteration wave
            if (usedUnderlyings.has(stock.symbol)) continue;

            // Combined exposure capacity for this underlying (existing + pending)
            const currentMV = toDollars((exposureByUnderlying[stock.symbol] || 0) + (pendingExposureByUnderlying[stock.symbol] || 0));

            // Compute exposure gap to per-trade cap; incremental allowed spend is min(perTradeCap, exposureGap)
            const exposureGap = Math.max(0, toDollars(perTradeCap - currentMV));
            const incrementalAllowed = Math.min(perTradeCap, exposureGap);
            if (incrementalAllowed < PARAMS.MIN_PRICE) continue;

            // Liquidity cap for shares only (minute volume × price × SPEND_MULT)
            const sharesLiquidityCap = toDollars(stock.volume * stock.ask * PARAMS.SPEND_MULT);

            // Base cap for both legs (budgets/exposure); remove redundant min with perTradeCap
            const baseCap = Math.min(
                remainingAlloc,
                dailyRemainingNow,
                incrementalAllowed
            );
            const sharesCap = Math.min(baseCap, sharesLiquidityCap);

            let symbolCap = toDollars(Math.max(0, baseCap));
            if (symbolCap < PARAMS.MIN_PRICE && sharesCap < PARAMS.MIN_PRICE) continue;

            // Build hybrid plan (options + equity). Shares limited by sharesCap; options by baseCap.
            const plans = await planOneHybrid(stock, symbolCap, sharesCap);
            if (!plans || plans.length === 0) continue;

            // Per requirement: select only ONE leg per ticker for the entire day (pick the largest spend)
            const chosen = plans.sort((a, b) => b.estSpend - a.estSpend)[0];
            if (!chosen || chosen.estSpend < PARAMS.MIN_PRICE) continue;

            // Reserve capacity and budget for this underlying with only the chosen leg
            batchPlans.push(chosen);
            usedUnderlyings.add(stock.symbol);
            pendingExposureByUnderlying[stock.symbol] = (pendingExposureByUnderlying[stock.symbol] || 0) + chosen.estSpend;
            remainingAlloc = toDollars(Math.max(0, remainingAlloc - chosen.estSpend));
            dailyRemainingNow = toDollars(Math.max(0, dailyRemainingNow - chosen.estSpend));

            if (remainingAlloc < PARAMS.MIN_PRICE || dailyRemainingNow < PARAMS.MIN_PRICE) break;
        }

        if (batchPlans.length === 0) break;

        // Execute planned buys sequentially to avoid bursts, still fast under dual limiter
        for (const p of batchPlans) {
            try {
                const cap = toDollars(initialBuyingPower * PARAMS.MAX_TRADE_PCT_OF_INITIAL_BP);
                const { qty: cappedQty } = await revalidateAndCapQtyBeforeBuy(p, cap);

                if (!cappedQty || cappedQty <= 0) {
                    log(`Skip ${p.symbol}: qty ${p.qty} -> 0 (per-trade or volume cap)`);
                    continue;
                }
                if (tradedSymbolsToday.has(p.underlying || p.symbol)) {
                    // Safety: if another wave or iteration already bought it, skip
                    log(`Skip ${p.symbol}: day gate already set for ${p.underlying || p.symbol}`);
                    continue;
                }
                if (cappedQty !== p.qty) {
                    log(`Cap ${p.symbol}: qty ${p.qty} -> ${cappedQty} (per-trade/volume)`);
                }

                const body = {
                    symbol: p.symbol,
                    qty: cappedQty,
                    side: "buy",
                    type: "market",
                    time_in_force: "day",
                    ...(p.assetClass === "option" ? { asset_class: "option" } : {})
                };
                const buyOrder = await request("orders", API.TRADE, { method: "POST", body: JSON.stringify(body) });

                // Wait for fill with a short exponential backoff (up to ~30s total)
                let filled = null;
                let delay = 1000;
                for (let i = 0; i < 8; i++) {
                    const st = await request(`orders/${buyOrder.id}`, API.TRADE);
                    if (st.status === "filled") { filled = st; break; }
                    await new Promise(res => setTimeout(res, delay));
                    delay = Math.min(8000, Math.floor(delay * 1.6));
                }
                if (!filled) {
                    // As a fallback, one last check before giving up
                    const st = await request(`orders/${buyOrder.id}`);
                    if (st.status === "filled") filled = st;
                }
                if (!filled) {
                    log(`Buy not filled in time: ${p.symbol}`);
                    continue;
                }

                const entryPrice = parseFloat(filled.filled_avg_price || p.entryAsk);

                // Use contract multiplier from plan or fetch it; avoid assuming 100
                let notional;
                if (p.assetClass === "option") {
                    let multForNotional = Number(p.multiplier);
                    if (!Number.isFinite(multForNotional) || multForNotional <= 0) {
                        multForNotional = await getOptionMultiplier(p.symbol).catch(() => 100);
                    }
                    notional = toDollars(cappedQty * entryPrice * multForNotional);
                } else {
                    notional = toDollars(cappedQty * entryPrice);
                }

                moneySpent += notional;

                // New: create shared client_order_id prefix for the sibling exits
                const cidPrefix = `oco-${(p.underlying || p.symbol)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;

                const exits = await placeCustomBracketOrders({
                    symbol: p.symbol,
                    qty: cappedQty,
                    assetClass: p.assetClass,
                    entryPrice,
                    clientIdPrefix: cidPrefix
                });

                // Register OCO group for WS-driven sibling cancellation
                registerOCOGroup(cidPrefix, p.symbol, exits);

                // Only monitor breakeven if a fixed stop exists (now disabled)
                if (!p.assetClass && exits.stopLossOrderId) {
                    monitorBreakevenStop(p.symbol, entryPrice, exits.stopLossOrderId).catch(() => {});
                }
                log(p.assetClass ? "Option BUY" : "Equity BUY", p.symbol, "qty", cappedQty, "avg", toDollars(entryPrice));

                // Mark the underlying as bought for the day (applies to equity and any options on the same ticker)
                tradedSymbolsToday.add(p.underlying || p.symbol);

                // Schedule non-profit exit
                scheduleNonProfitExit({ symbol: p.symbol, assetClass: p.assetClass });
            } catch (e) {
                log("Buy error:", e?.message || e);
            }
        }

        waves++;
        // loop re-evaluates remainingAlloc/dailyRemainingNow; will exit when exhausted or no plans left
    }

    // End-of-iteration cleanup guard based on effective daily budget
    if (moneySpent + PARAMS.MIN_PRICE > getDailyBudget()) {
        await cleanup();
    }
}

// Initialize day state once at startup
await ensureDayState();
log("Initialized. Tradable NYSE symbols:", symbols.length);

// New: connect trade_updates WebSocket for immediate sibling cancellations
connectTradeUpdates();

// Replace raw stdin handler with readline prompt
rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "cmd> "
});
rl.on("line", async (raw) => {
    const line = String(raw || "").trim();
    if (!line) {
        rl.prompt();
        return;
    }
    const cmd = line.toLowerCase();

    if (cmd === "dump") {
        tradingPaused = true; // immediately prevent new orders
        log('Command: "dump" received -> flattening and pausing trading.');
        await flattenAndCancel();
        log('Dump complete. Trading remains paused until "pump".');
    } else if (cmd === "pump") {
        tradingPaused = false;
        log('Command: "pump" received -> trading resumed (no positions reinstated).');
    } else {
        log("Unknown command:", line);
    }
    rl.prompt();
});
rl.on("SIGINT", () => {
    // Handle Ctrl+C gracefully
    log("SIGINT received. Exiting...");
    stopped = true;
    rl.close();
    process.exit(0);
});
rl.prompt();

// --- Scheduler: run loop + countdown progress bar ---
async function runLoop() {
    while (!stopped) {
        try {
            await algo();
        } catch (e) {
            log("Iteration error:", e?.message || e);
        }
        if (!stopped) {
            await waitWithProgress(PARAMS.INTERVAL);
        }
    }
}

runLoop();