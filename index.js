//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

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
    //Time to cancel all orders and close out of all positions (24-hr, eastern time)
    CLOSING: {
        HOURS: 15,
        MINUTES: 30
    }
};

const ratelimiter = new Ratelimiter(RATELIMIT_MAX_REQ, RATELIMIT_TIMESPAN);

function toDollars(x) {
    return Math.round(x * 100) / 100;
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

    const cleanupTime = new Date();
    cleanupTime.setHours(15);
    cleanupTime.setMinutes(30);

    setTimeout(async () => {
        await request("positions", API.TRADE, {
            method: "DELETE",
            params: {
                cancel_orders: true
            }
        });
    }, cleanupTime.valueOf() - Date.now());
}

async function algo() {
    //TODO: how to ensure Eastern Time??
    const now = new Date();
    if((now.getHours() === PARAMS.CLOSING.HOURS && now.getMinutes() + PARAMS.INTERVAL / 60 / 1000 >= PARAMS.CLOSING.MINUTES)) {
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

    for(const stock of stocks) {
        const curPosition = await request(`positions/${stock.symbol}`, API.TRADE);

        if(curPosition.market_value / equity >= PARAMS.MAX_PERCENTAGE_PER_STOCK) {
            continue;
        }

        //$ amount to buy (probably fractional)
        let notional = toDollars(Math.min(buyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE, stock.volume * stock.ask * PARAMS.SPEND_MULT));

        //try to spend the last of our money if we were going to go over
        if(moneySpent + notional > PARAMS.MAX_PER_DAY) {
            notional = PARAMS.MAX_PER_DAY - moneySpent;
        }

        //convert to shares
        const qty = Math.floor(notional / stock.ask);

        //don't bother buying 0 shares :)
        //this, along with the if statement above, also implicitly ensures that we don't go over our spending limit
        if(qty === 0) {
            continue;
        }

        //actual dollar amount we're buying now
        moneySpent += qty * stock.ask;
//TODO
        const res =  await request("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "buy",
                type: "market",
                time_in_force: "day",
                order_class: "bracket",
                take_profit : {
                    limit_price: Math.max(toDollars(stock.ask * PARAMS.LIMIT_PRICE_MULT), stock.ask + 0.01) //TODO: stock.ask is not the price we always get in a market order
                },
                stop_loss: {
                    stop_price: Math.min(toDollars(stock.ask * PARAMS.STOP_PRICE_MULT), stock.ask - 0.01)
                }
            })
        });

        console.log(res);

        //no need to wait for a response to do the next order
        await ratelimiter.consume();
        noRatelimitRequest("orders", API.TRADE, {
            method: "POST",
            body: JSON.stringify({
                symbol: stock.symbol,
                qty,
                side: "sell",
                type: "trailing_stop",
                time_in_force: "day",
                trail_percent: PARAMS.TRAILING_STOP_PERCENT
            })
        });

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