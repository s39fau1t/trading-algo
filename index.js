//alpaca paper trading
//key: PKEMJZFGOJ6JDHDOLOJC6PYE2D
//secret: GL3UD9kbckymMGBWF7cHvniPo8RFgENrE33BpZJWtVHz
//testing commit
//testing commit 3

import Ratelimiter from "./ratelimiter.js";

const API = Object.freeze({
    DOMAIN: "alpaca.markets/v2",
    KEY: "PKEMJZFGOJ6JDHDOLOJC6PYE2D",
    SECRET: "GL3UD9kbckymMGBWF7cHvniPo8RFgENrE33BpZJWtVHz",
    TRADE: "paper-api",
    DATA: "data"
});

const RATELIMIT_MAX_REQ = 200;
const RATELIMIT_TIMESPAN = 1 * 60 * 1000;

const PARAMS = {
    //Interval between each iteration of the algo (ms)
    INTERVAL: 30 * 1000,
    //Max money spent per day (dollars)
    MAX_PER_DAY: 2000,
    //Minimum price of a stock before consider buying it (dollars)
    MIN_PRICE: 5,
    //Maximum percentage of the portfolio that can be one stock
    MAX_PERCENTAGE_PER_STOCK: 0.03,
    //Multiplier for the amount to spend on a particular stock
    SPEND_MULT: 0.05,
    //Maximum percentage of buying power that can be spent on a particular stock at once
    MAX_BUYING_POWER_AT_ONCE: 0.02,
    //Multiplier to calculate the take profit price for bracket orders (ask price * LIMIT_PRICE_MULT = limit_price)
    LIMIT_PRICE_MULT: 1.1,
    //Multiplier to calculate the stop price (ask price * STOP_PRICE_MULT = stop_price)
    STOP_PRICE_MULT: 0.995,
    //Percent away from the highest water mark for trailing stop orders
    TRAILING_STOP_PERCENT: 1,
    // Take profit percent above filled buy price (e.g., 5 = +5%)
    TAKE_PROFIT_PERCENT: 5,
    //Time to cancel all orders and close out of all positions (24-hr, eastern time)
    CLOSING: {
        HOURS: 15,
        MINUTES: 30
    },
    // Minutes to look back for historical price comparison
    LOOKBACK_MINUTES: 10
};

const ratelimiter = new Ratelimiter(RATELIMIT_MAX_REQ, RATELIMIT_TIMESPAN);

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
    console.log(`[${etNow()} ET]`, ...args);
}

// Add: runtime trading pause flag
let tradingPaused = false;
// Add: automatic off-hours guard (3:30 PM -> 9:40 AM ET)
let offHoursActive = false;

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
                if (process.stdout.isTTY) process.stdout.write("\n");
                return resolve();
            }

            if (process.stdout.isTTY) {
                drawProgress(remaining, totalMs, label);
            } else if (elapsed === 0) {
                log(label, formatDuration(totalMs));
            }

            if (remaining <= 0) {
                clearInterval(handle);
                if (process.stdout.isTTY) process.stdout.write("\n");
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
    await ratelimiter.consume();

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
function getUnderlyingFromOptionSymbol(sym) {
    // Extract leading letters/dots as underlying (e.g., AAPL240118C00190000 -> AAPL)
    const m = String(sym).match(/^[A-Z.]+/);
    return m ? m[0] : sym;
}

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

// New: ensure day state (reset on ET date change)
async function ensureDayState() {
    const dayKey = getETDateKey();
    if (currentDayKey !== dayKey || !initialBuyingPower) {
        const account = await request("account", API.TRADE);
        initialBuyingPower = parseFloat(account.cash || "0");
        currentDayKey = dayKey;
        moneySpent = 0;
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

// Add: non-blocking OCO monitor helper (detached)
async function monitorOCO(stopLossOrderId, trailingStopOrderId, takeProfitOrderId) {
    const cancelIfOpen = async (id) => {
        try { await request(`orders/${id}`, API.TRADE, { method: "DELETE" }); } catch {}
    };
    try {
        let resolved = false;
        while (!resolved) {
            const [slStatus, tsStatus, tpStatus] = await Promise.all([
                request(`orders/${stopLossOrderId}`, API.TRADE),
                request(`orders/${trailingStopOrderId}`, API.TRADE),
                request(`orders/${takeProfitOrderId}`, API.TRADE)
            ]);

            if (slStatus.status === "filled") {
                await Promise.all([cancelIfOpen(trailingStopOrderId), cancelIfOpen(takeProfitOrderId)]);
                resolved = true;
            } else if (tsStatus.status === "filled") {
                await Promise.all([cancelIfOpen(stopLossOrderId), cancelIfOpen(takeProfitOrderId)]);
                resolved = true;
            } else if (tpStatus.status === "filled") {
                await Promise.all([cancelIfOpen(stopLossOrderId), cancelIfOpen(trailingStopOrderId)]);
                resolved = true;
            } else if (
                ["canceled", "expired"].includes(slStatus.status) &&
                ["canceled", "expired"].includes(tsStatus.status) &&
                ["canceled", "expired"].includes(tpStatus.status)
            ) {
                resolved = true;
            } else {
                await new Promise(res => setTimeout(res, 5000));
            }
        }
    } catch {
        // swallow background errors
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
        log("Trading paused (dump it active). Skipping order placement.");
        return;
    }

    await ensureDayState();

    const snapshots = await getStocksSnapshots(symbols);

    // Pre-filter viable symbols and gather for historical lookup
    const viableSymbols = [];
    for (const [symbol, snapshot] of Object.entries(snapshots)) {
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

    const account = await request("account", API.TRADE);
    const equity = parseFloat(account.equity);
    const buyingPower = parseFloat(account.cash);

    // Build combined exposure (equity + options) by underlying symbol
    const positions = await request("positions", API.TRADE);
    const exposureByUnderlying = {};
    for (const p of positions) {
        const underlying = p.asset_class === "option" ? getUnderlyingFromOptionSymbol(p.symbol) : p.symbol;
        exposureByUnderlying[underlying] = (exposureByUnderlying[underlying] || 0) + parseFloat(p.market_value);
    }

    // New: per-iteration allocation based on initial day BP
    let remainingAlloc = toDollars(Math.max(0, initialBuyingPower - moneySpent - 5));
    let dailyRemainingNow = toDollars(Math.max(0, PARAMS.MAX_PER_DAY - moneySpent));
    if (remainingAlloc < PARAMS.MIN_PRICE || dailyRemainingNow < PARAMS.MIN_PRICE) {
        log("Insufficient remaining budget for new trades this iteration.");
        return;
    }

    // Track pending exposure additions within this iteration
    const pendingExposureByUnderlying = {};

    for (const stock of stocks) {
        // Stop if we ran out of allocation or daily cap room
        remainingAlloc = toDollars(Math.max(0, initialBuyingPower - moneySpent - 5));
        dailyRemainingNow = toDollars(Math.max(0, PARAMS.MAX_PER_DAY - moneySpent));
        if (remainingAlloc < PARAMS.MIN_PRICE || dailyRemainingNow < PARAMS.MIN_PRICE) break;

        // Combined exposure limit for this underlying (existing + pending)
        const underlying = stock.symbol;
        const threshold = toDollars(equity * PARAMS.MAX_PERCENTAGE_PER_STOCK);
        const currentMV = toDollars((exposureByUnderlying[underlying] || 0) + (pendingExposureByUnderlying[underlying] || 0));
        const exposureCapacity = Math.max(0, toDollars(threshold - currentMV));
        if (exposureCapacity <= 0) continue;

        // Per-trade sizing caps
        const volumeCap = toDollars(stock.volume * stock.ask * PARAMS.SPEND_MULT);
        const perTradeCapInitial = toDollars(initialBuyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE);
        const perTradeCapRuntime = toDollars(buyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE);

        // Budget available for this symbol
        let symbolCap = Math.min(
            remainingAlloc,
            dailyRemainingNow,
            volumeCap,
            exposureCapacity,
            perTradeCapInitial,
            perTradeCapRuntime
        );
        symbolCap = toDollars(Math.max(0, symbolCap));
        if (symbolCap < PARAMS.MIN_PRICE) continue;

        // Try to buy ITM call options first using symbolCap
        let traded = false;
        try {
            const targetStrike = stock.ask * 0.95;
            const contract = await getNearestITMCallContract(stock.symbol, targetStrike);
            if (contract && contract.symbol) {
                const quotes = await request("options/quotes/latest", API.DATA, { params: { symbols: contract.symbol } });
                const optQuote = quotes[contract.symbol] || quotes.latestQuote || quotes.latestQuotes?.[contract.symbol];
                const optAsk = optQuote?.ap || optQuote?.ask_price || 0;

                if (optAsk > 0) {
                    const contractsQty = toWholeQty(symbolCap / (optAsk * 100));
                    if (contractsQty > 0) {
                        // Place buy order (option)
                        const buyOrder = await request("orders", API.TRADE, {
                            method: "POST",
                            body: JSON.stringify({
                                symbol: contract.symbol,
                                asset_class: "option",
                                qty: contractsQty,
                                side: "buy",
                                type: "market",
                                time_in_force: "day"
                            })
                        });

                        // Wait for fill
                        let filled = false;
                        let buyOrderStatus;
                        for (let i = 0; i < 10; i++) {
                            buyOrderStatus = await request(`orders/${buyOrder.id}`, API.TRADE);
                            if (buyOrderStatus.status === "filled") { filled = true; break; }
                            await new Promise(res => setTimeout(res, 2000));
                        }
                        if (!filled) {
                            log(`Option buy not filled in time: ${contract.symbol}`);
                        } else {
                            // Actual spend and risk tracking
                            const entryPriceOpt = parseFloat(buyOrderStatus.filled_avg_price || optAsk);
                            const notionalOpt = toDollars(contractsQty * entryPriceOpt * 100);

                            // Update budgets and exposure
                            moneySpent += notionalOpt;
                            pendingExposureByUnderlying[underlying] = (pendingExposureByUnderlying[underlying] || 0) + notionalOpt;

                            // Place exits
                            const takeProfitPriceOpt = toDollars(entryPriceOpt * (1 + PARAMS.TAKE_PROFIT_PERCENT / 100));
                            const stopLossPrice = Math.min(toDollars(entryPriceOpt * PARAMS.STOP_PRICE_MULT), entryPriceOpt - 0.01);

                            const stopLossOrder = await request("orders", API.TRADE, {
                                method: "POST",
                                body: JSON.stringify({
                                    symbol: contract.symbol,
                                    asset_class: "option",
                                    qty: contractsQty,
                                    side: "sell",
                                    type: "stop",
                                    time_in_force: "gtc",
                                    stop_price: stopLossPrice
                                })
                            });
                            const trailingStopOrder = await request("orders", API.TRADE, {
                                method: "POST",
                                body: JSON.stringify({
                                    symbol: contract.symbol,
                                    asset_class: "option",
                                    qty: contractsQty,
                                    side: "sell",
                                    type: "trailing_stop",
                                    time_in_force: "gtc",
                                    trail_percent: PARAMS.TRAILING_STOP_PERCENT
                                })
                            });
                            const takeProfitOrder = await request("orders", API.TRADE, {
                                method: "POST",
                                body: JSON.stringify({
                                    symbol: contract.symbol,
                                    asset_class: "option",
                                    qty: contractsQty,
                                    side: "sell",
                                    type: "limit",
                                    time_in_force: "gtc",
                                    limit_price: takeProfitPriceOpt
                                })
                            });

                            // Fire-and-forget OCO monitoring
                            monitorOCO(stopLossOrder.id, trailingStopOrder.id, takeProfitOrder.id).catch(() => {});
                            log("Option BUY", contract.symbol, "qty", contractsQty, "avg", toDollars(entryPriceOpt));
                            traded = true;
                        }
                    }
                }
            }
        } catch {
            // ignore option path errors; try equity
        }
        if (traded) continue;

        // Fallback: equity trade using symbolCap
        const qty = toWholeQty(symbolCap / stock.ask);
        if (qty === 0) continue;

        // Place market buy (equity)
        const buyOrder = await request("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "buy",
                type: "market",
                time_in_force: "day"
            })
        });

        // Wait for the buy order to fill
        let filled = false;
        let buyOrderStatus;
        for (let i = 0; i < 10; i++) {
            buyOrderStatus = await request(`orders/${buyOrder.id}`, API.TRADE);
            if (buyOrderStatus.status === "filled") { filled = true; break; }
            await new Promise(res => setTimeout(res, 2000));
        }
        if (!filled) {
            log(`Equity buy not filled in time: ${stock.symbol}`);
            continue;
        }

        // Compute entry price and update budgets/exposure
        const entryPrice = parseFloat(buyOrderStatus.filled_avg_price || stock.ask);
        const notional = toDollars(qty * entryPrice);
        moneySpent += notional;
        pendingExposureByUnderlying[underlying] = (pendingExposureByUnderlying[underlying] || 0) + notional;

        // Place exits
        const takeProfitPrice = toDollars(entryPrice * (1 + PARAMS.TAKE_PROFIT_PERCENT / 100));
        const stopLossPrice = Math.min(toDollars(entryPrice * PARAMS.STOP_PRICE_MULT), entryPrice - 0.01);

        const stopLossOrder = await request("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "sell",
                type: "stop",
                time_in_force: "gtc",
                stop_price: stopLossPrice
            })
        });
        const trailingStopOrder = await request("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "sell",
                type: "trailing_stop",
                time_in_force: "gtc",
                trail_percent: PARAMS.TRAILING_STOP_PERCENT
            })
        });
        const takeProfitOrder = await request("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "sell",
                type: "limit",
                time_in_force: "gtc",
                limit_price: takeProfitPrice
            })
        });

        // Fire-and-forget OCO monitoring
        monitorOCO(stopLossOrder.id, trailingStopOrder.id, takeProfitOrder.id).catch(() => {});
        log("Equity BUY", stock.symbol, "qty", qty, "avg", toDollars(entryPrice));

        // Guard: stop if we have no budget left for at least one more min trade
        remainingAlloc = toDollars(Math.max(0, initialBuyingPower - moneySpent - 5));
        dailyRemainingNow = toDollars(Math.max(0, PARAMS.MAX_PER_DAY - moneySpent));
        if (remainingAlloc < PARAMS.MIN_PRICE || dailyRemainingNow < PARAMS.MIN_PRICE) break;
    }

    if (moneySpent + PARAMS.MIN_PRICE > PARAMS.MAX_PER_DAY) {
        await cleanup();
    }
}

// Initialize day state once at startup
await ensureDayState();
log("Initialized. Tradable NYSE symbols:", symbols.length);

// Add: stdin command handler ("dump it" / "pump it")
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", async (chunk) => {
    for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.toLowerCase();

        if (cmd === "dump it") {
            tradingPaused = true; // immediately prevent new orders
            log('Command: "dump it" received -> flattening and pausing trading.');
            await flattenAndCancel();
            log('Dump complete. Trading remains paused until "pump it".');
        } else if (cmd === "pump it") {
            tradingPaused = false;
            log('Command: "pump it" received -> trading resumed (no positions reinstated).');
        } else {
            log("Unknown command:", line);
        }
    }
});

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