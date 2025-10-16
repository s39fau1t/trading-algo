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
    INTERVAL: 10 * 60 * 1000,
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
    }
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

async function getStocksSnapshots(allSymbols, batchSize = 200) {
    const out = {};
    for (let i = 0; i < allSymbols.length; i += batchSize) {
        const batch = allSymbols.slice(i, i + batchSize);
        const resp = await request("stocks/snapshots", API.DATA, { params: { symbols: batch } });
        Object.assign(out, normalizeSnapshots(resp));
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

let lastSnapshots;

async function cleanup() {
    clearInterval(handle);
    stopped = true;

    // Schedule the close at exactly 15:30 ET (today)
    const { hour, minute, second } = getEasternTimeParts();
    const targetHour = PARAMS.CLOSING.HOURS;
    const targetMinute = PARAMS.CLOSING.MINUTES;
    const nowTotalSec = hour * 3600 + minute * 60 + second;
    const targetTotalSec = targetHour * 3600 + targetMinute * 60;
    const waitMs = Math.max(0, (targetTotalSec - nowTotalSec) * 1000);

    log("Cleanup scheduled. Will attempt to close all positions at", `${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")} ET`);

    setTimeout(async () => {
        log("Closing all positions and canceling open orders...");
        await request("positions", API.TRADE, {
            method: "DELETE",
            params: {
                cancel_orders: true
            }
        });
        log("Close-out request sent.");
    }, waitMs);
}

async function algo() {
    log("Iteration start");

    // Ensure Eastern Time for closing logic
    const { hour: etHour, minute: etMinute } = getEasternTimeParts();
    if (etHour === PARAMS.CLOSING.HOURS && etMinute + PARAMS.INTERVAL / 60 / 1000 >= PARAMS.CLOSING.MINUTES) {
        await cleanup();
    }

    await ensureDayState();

    const snapshots = await getStocksSnapshots(symbols);

    const stocks = [];

    for(const [symbol, snapshot] of Object.entries(snapshots)) {
        //sometimes minute bar or latest quote is not available
        if(!snapshot?.minuteBar || !snapshot?.latestQuote) {
            continue;
        }

        const lastPrev = lastSnapshots?.[symbol];
        const lastAsk = lastPrev?.latestQuote?.ap ?? 0;

        const ask = snapshot.latestQuote.ap;
        if(ask < PARAMS.MIN_PRICE || lastAsk === 0) {
            continue;
        }

        stocks.push({
            symbol,
            ask,
            volume: snapshot.minuteBar.v,
            change: (ask - lastAsk) / lastAsk
        });
    }

    stocks.sort((a, b) => {
        if(a.change > b.change) {
            return -1;
        }else if(a.change < b.change) {
            return 1;
        }

        return 0;
    });

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

    for (const stock of stocks) {
        // Enforce combined exposure limit
        const combinedMV = exposureByUnderlying[stock.symbol] || 0;
        if (combinedMV / equity >= PARAMS.MAX_PERCENTAGE_PER_STOCK) {
            continue;
        }

        // Per-trade sizing caps
        const perTradeCap = toDollars(initialBuyingPower * 0.02); // 2% of initial day BP
        const volumeCap = toDollars(stock.volume * stock.ask * PARAMS.SPEND_MULT); // 5% of current minute volume $
        let targetNotional = Math.min(perTradeCap, volumeCap);

        // Skip if target notional would exceed remaining daily budget
        if (moneySpent + targetNotional > PARAMS.MAX_PER_DAY) {
            continue;
        }

        // Try to buy ITM call options first using the same target notional
        let didOptionTrade = false;
        try {
            const targetStrike = stock.ask * 0.95;
            const contract = await getNearestITMCallContract(stock.symbol, targetStrike);
            if (contract && contract.symbol) {
                const quotes = await request("options/quotes/latest", API.DATA, {
                    params: { symbols: contract.symbol }
                });
                const optQuote = quotes[contract.symbol] || quotes.latestQuote || quotes.latestQuotes?.[contract.symbol];
                const optAsk = optQuote?.ap || optQuote?.ask_price || 0;

                if (optAsk > 0) {
                    // Calculate whole contracts from target notional (100x multiplier)
                    const contractsQty = toWholeQty(targetNotional / (optAsk * 100));
                    if (contractsQty > 0) {
                        const notionalOpt = toDollars(contractsQty * optAsk * 100);

                        // Skip if insufficient cash
                        if (notionalOpt > buyingPower) {
                            log("Skip option (insufficient cash):", contract.symbol, "need", notionalOpt);
                            continue;
                        }

                        log("Option BUY", contract.symbol, "qty", contractsQty, "ask", toDollars(optAsk));

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
                            if (buyOrderStatus.status === "filled") {
                                filled = true;
                                break;
                            }
                            await new Promise(res => setTimeout(res, 2000));
                        }
                        if (!filled) {
                            log(`Option buy not filled in time: ${contract.symbol}`);
                            continue;
                        }

                        // Record spend using actual notional
                        moneySpent += notionalOpt;

                        // Compute entry price and take profit for option (per-contract premium)
                        const entryPriceOpt = parseFloat(buyOrderStatus.filled_avg_price || optAsk);
                        log("Option FILLED", contract.symbol, "avg", toDollars(entryPriceOpt));
                        const takeProfitPriceOpt = toDollars(entryPriceOpt * (1 + PARAMS.TAKE_PROFIT_PERCENT / 100));

                        // Place stop-loss sell (option)
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

                        // Place trailing stop sell (option)
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

                        // Place take-profit limit sell (option)
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

                        log("Option OCO placed", contract.symbol, "TP", takeProfitPriceOpt, "SL", Math.min(toDollars(entryPriceOpt * PARAMS.STOP_PRICE_MULT), entryPriceOpt - 0.01), "TR", `${PARAMS.TRAILING_STOP_PERCENT}%`);

                        // OCO monitor (three orders): cancel the other two when one fills
                        let ocoResolved = false;
                        while (!ocoResolved) {
                            const [slStatus, tsStatus, tpStatus] = await Promise.all([
                                request(`orders/${stopLossOrder.id}`, API.TRADE),
                                request(`orders/${trailingStopOrder.id}`, API.TRADE),
                                request(`orders/${takeProfitOrder.id}`, API.TRADE)
                            ]);

                            const cancelIfOpen = async (id) => {
                                try { await request(`orders/${id}`, API.TRADE, { method: "DELETE" }); } catch {}
                            };

                            if (slStatus.status === "filled") {
                                await Promise.all([
                                    cancelIfOpen(trailingStopOrder.id),
                                    cancelIfOpen(takeProfitOrder.id)
                                ]);
                                ocoResolved = true;
                            } else if (tsStatus.status === "filled") {
                                await Promise.all([
                                    cancelIfOpen(stopLossOrder.id),
                                    cancelIfOpen(takeProfitOrder.id)
                                ]);
                                ocoResolved = true;
                            } else if (tpStatus.status === "filled") {
                                await Promise.all([
                                    cancelIfOpen(stopLossOrder.id),
                                    cancelIfOpen(trailingStopOrder.id)
                                ]);
                                ocoResolved = true;
                            } else if (
                                ["canceled", "expired"].includes(slStatus.status) &&
                                ["canceled", "expired"].includes(tsStatus.status) &&
                                ["canceled", "expired"].includes(tpStatus.status)
                            ) {
                                ocoResolved = true;
                            } else {
                                await new Promise(res => setTimeout(res, 5000));
                            }
                        }

                        // If we reached here, option trade completed; skip stock trade
                        didOptionTrade = true;

                        if (moneySpent + PARAMS.MIN_PRICE > PARAMS.MAX_PER_DAY) {
                            break;
                        }
                    }
                }
            }
        } catch (_) {
            // Swallow option errors and fall back to stock path
        }
        if (didOptionTrade) continue;

        // Fallback: original stock trade path
        //$ amount to buy (probably fractional)
        let notional = toDollars(Math.min(buyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE, stock.volume * stock.ask * PARAMS.SPEND_MULT));

        //try to spend the last of our money if we were going to go over
        if(moneySpent + notional > PARAMS.MAX_PER_DAY) {
            notional = PARAMS.MAX_PER_DAY - moneySpent;
        }

        //convert to shares — enforce whole shares
        const qty = toWholeQty(notional / stock.ask);

        //don't bother buying 0 shares :)
        //this, along with the if statement above, also implicitly ensures that we don't go over our spending limit
        if(qty === 0) {
            continue;
        }

        log("Equity BUY", stock.symbol, "qty", qty, "ask", toDollars(stock.ask));

        //actual dollar amount we're buying now
        moneySpent += qty * stock.ask;

        // --- Custom Bracket Order with Stop Loss and Trailing Stop (OCO) ---
        // Place market buy order
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
            if (buyOrderStatus.status === "filled") {
                filled = true;
                break;
            }
            await new Promise(res => setTimeout(res, 2000));
        }
        if (!filled) {
            log(`Equity buy not filled in time: ${stock.symbol}`);
            continue;
        }

        // Compute entry price and take profit for stock
        const entryPrice = parseFloat(buyOrderStatus.filled_avg_price || stock.ask);
        log("Equity FILLED", stock.symbol, "avg", toDollars(entryPrice));
        const takeProfitPrice = toDollars(entryPrice * (1 + PARAMS.TAKE_PROFIT_PERCENT / 100));

        // Place stop-loss sell order
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

        // Place trailing stop sell order
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

        // Place take-profit limit sell order
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

        log("Equity OCO placed", stock.symbol, "TP", takeProfitPrice, "SL", Math.min(toDollars(entryPrice * PARAMS.STOP_PRICE_MULT), entryPrice - 0.01), "TR", `${PARAMS.TRAILING_STOP_PERCENT}%`);

        // OCO logic: monitor three sell orders, cancel the other two when one fills
        let ocoResolved = false;
        while (!ocoResolved) {
            const [slStatus, tsStatus, tpStatus] = await Promise.all([
                request(`orders/${stopLossOrder.id}`, API.TRADE),
                request(`orders/${trailingStopOrder.id}`, API.TRADE),
                request(`orders/${takeProfitOrder.id}`, API.TRADE)
            ]);

            const cancelIfOpen = async (id) => {
                try { await request(`orders/${id}`, API.TRADE, { method: "DELETE" }); } catch {}
            };

            if (slStatus.status === "filled") {
                await Promise.all([
                    cancelIfOpen(trailingStopOrder.id),
                    cancelIfOpen(takeProfitOrder.id)
                ]);
                ocoResolved = true;
                console.log(`Stop-loss filled for ${stock.symbol}, trailing stop and take-profit canceled.`);
            } else if (tsStatus.status === "filled") {
                await Promise.all([
                    cancelIfOpen(stopLossOrder.id),
                    cancelIfOpen(takeProfitOrder.id)
                ]);
                ocoResolved = true;
                console.log(`Trailing stop filled for ${stock.symbol}, stop-loss and take-profit canceled.`);
            } else if (tpStatus.status === "filled") {
                await Promise.all([
                    cancelIfOpen(stopLossOrder.id),
                    cancelIfOpen(trailingStopOrder.id)
                ]);
                ocoResolved = true;
                console.log(`Take-profit filled for ${stock.symbol}, stop-loss and trailing stop canceled.`);
            } else if (
                ["canceled", "expired"].includes(slStatus.status) &&
                ["canceled", "expired"].includes(tsStatus.status) &&
                ["canceled", "expired"].includes(tpStatus.status)
            ) {
                ocoResolved = true;
            } else {
                await new Promise(res => setTimeout(res, 5000));
            }
        }

        //since we're only buying whole shares, this ensures the algo won't run infinetly doing nothing
        //we know we won't be able to buy any more shares anyway in this case, so just exit
        if(moneySpent + PARAMS.MIN_PRICE > PARAMS.MAX_PER_DAY) {
            log("Daily budget reached. Initiating cleanup...");
            break;
        }
    }

    if(moneySpent + PARAMS.MIN_PRICE > PARAMS.MAX_PER_DAY) {
        await cleanup();
    }

    lastSnapshots = snapshots;
}

// Initialize day state once at startup
await ensureDayState();
log("Initialized. Tradable NYSE symbols:", symbols.length);

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