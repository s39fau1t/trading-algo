//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO
//testing commit
//testing commit 3

import Ratelimiter from "./ratelimiter.js";

const API = Object.freeze({
    DOMAIN: "alpaca.markets/v2",
    KEY: "PKF2GCQC43DWPXMO8VQS",
    SECRET: "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO",
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

function toDollars(x) {
    return Math.round(x * 100) / 100;
}

// Ensure only whole, positive quantities are used in orders
function toWholeQty(x) {
    const q = Math.floor(Number(x) || 0);
    return Number.isFinite(q) && q > 0 ? q : 0;
}

async function noRatelimitRequest(path, type, options) {
    const res = await fetch(`https://${type}.${API.DOMAIN}/${path}?${new URLSearchParams(options.params).toString()}`, {
        method: options.method,
        headers: {
            accept: "application/json",
            "APCA-API-KEY-ID": API.KEY,
            "APCA-API-SECRET-KEY": API.SECRET
        },
        body: options.body
    });

    /*
    TODO: look at these headers for possibly more efficient ratelimiting
    console.log(res.headers.get("X-RateLimit-Limit"));
    console.log(res.headers.get("X-RateLimit-Remaining"));
    console.log(res.headers.get("X-RateLimit-Reset"));
    */

    return await res.json();
}

async function request(path, type, options = {
    method: "GET",
    params: {},
    body: null
}) {
    await ratelimiter.consume();

    return await noRatelimitRequest(path, type, options);
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

const assets = await request("assets", API.TRADE, {
    params: {
        status: "active",
        asset_class: "us_equity"
    }
});

const symbols = assets.filter(asset => asset.tradable && (asset.exchange === "NYSE")).map(asset => asset.symbol);

let moneySpent = 0;

let handle, lastSnapshots;

async function cleanup() {
    clearInterval(handle);

    // Schedule the close at exactly 15:30 ET (today)
    const { hour, minute, second } = getEasternTimeParts();
    const targetHour = PARAMS.CLOSING.HOURS;
    const targetMinute = PARAMS.CLOSING.MINUTES;
    const nowTotalSec = hour * 3600 + minute * 60 + second;
    const targetTotalSec = targetHour * 3600 + targetMinute * 60;
    const waitMs = Math.max(0, (targetTotalSec - nowTotalSec) * 1000);

    setTimeout(async () => {
        await request("positions", API.TRADE, {
            method: "DELETE",
            params: {
                cancel_orders: true
            }
        });
    }, waitMs);
}

async function algo() {
    // Ensure Eastern Time for closing logic
    const { hour: etHour, minute: etMinute } = getEasternTimeParts();
    if (etHour === PARAMS.CLOSING.HOURS && etMinute + PARAMS.INTERVAL / 60 / 1000 >= PARAMS.CLOSING.MINUTES) {
        await cleanup();
    }

    const snapshots = await request("stocks/snapshots", API.DATA, {
        params: {
            symbols
        }
    });

    const stocks = [];

    for(const [symbol, snapshot] of Object.entries(snapshots)) {
        //sometimes minute bar or latest quote is not available
        if(!snapshot.minuteBar || !snapshot.latestQuote) {
            continue;
        }

        const lastAsk = lastSnapshots[symbol].latestQuote.ap;

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

        // Try to buy ITM call options first (nearest expiry, strike <= 95% of ask, closest to that)
        let didOptionTrade = false;
        try {
            const targetStrike = stock.ask * 0.95;
            const contract = await getNearestITMCallContract(stock.symbol, targetStrike);
            if (contract && contract.symbol) {
                // Get latest option quote for pricing
                const quotes = await request("options/quotes/latest", API.DATA, {
                    params: { symbols: contract.symbol }
                });

                // Handle possible shapes: { [symbol]: { ap } } or { latestQuotes: { ... } }
                const optQuote = quotes[contract.symbol] || quotes.latestQuote || quotes.latestQuotes?.[contract.symbol];
                const optAsk = optQuote?.ap || optQuote?.ask_price || 0;

                if (optAsk > 0) {
                    // Determine spend (premium dollars). Use same notional rule as stock.
                    let notional = toDollars(Math.min(
                        buyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE,
                        stock.volume * stock.ask * PARAMS.SPEND_MULT
                    ));

                    if (moneySpent + notional > PARAMS.MAX_PER_DAY) {
                        notional = PARAMS.MAX_PER_DAY - moneySpent;
                    }

                    // Convert to contracts (100x multiplier) — enforce whole contracts
                    const contractsQty = toWholeQty(notional / (optAsk * 100));

                    if (contractsQty > 0) {
                        // Buy option contracts (market)
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
                            // If not filled, skip bracket creation and fall back to next stock
                            continue;
                        }

                        // Record spend
                        moneySpent += contractsQty * optAsk * 100;

                        // Compute entry price and take profit for option (per-contract premium)
                        const entryPriceOpt = parseFloat(buyOrderStatus.filled_avg_price || optAsk);
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
            console.log(`Buy order for ${stock.symbol} not filled in time, skipping OCO.`);
            continue;
        }

        // Compute entry price and take profit for stock
        const entryPrice = parseFloat(buyOrderStatus.filled_avg_price || stock.ask);
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
                console.log(`Stop-loss filled for ${stock.symbol, trailingStopOrder.id}, trailing stop and take-profit canceled.`);
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
                console.log(`Take-profit filled for ${stock.symbol, stopLossOrder.id}, stop-loss and trailing stop canceled.`);
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
            break;
        }
    }

    if(moneySpent + PARAMS.MIN_PRICE > PARAMS.MAX_PER_DAY) {
        await cleanup();
    }

    lastSnapshots = snapshots;
}

lastSnapshots = await request("stocks/snapshots", API.DATA, {
    params: {
        symbols
    }
});

handle = setInterval(algo, PARAMS.INTERVAL);