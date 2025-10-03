//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

import Ratelimiter from "./ratelimiter.js";

const API = Object.freeze({
    DOMAIN: "alpaca.markets/v2",
    KEY: "PKF2GCQC43DWPXMO8VQS",
    SECRET: "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO",
    PAPER: "paper-api",
    DATA: "data"
});

const RATELIMIT_MAX_REQ = 200;
const RATELIMIT_TIMESPAN = 1 * 60 * 1000;

//TODO
const PARAMS = {
    //Interval between each iteration of the algo (ms)
    INTERVAL: 10 * 60 * 1000,
    //Max money spent per day (dollars)
    MAX_PER_DAY: 2000,
    //Minimum price of a stock before consider buying it (dollars)
    MIN_PRICE: 5,
    //Maximum percentage of the portfolio that can be one stock
    MAX_PERCENTAGE_PER_STOCK: 0.3,
    //Multiplier for the amount to spend on a particular stock
    SPEND_MULT: 0.05,
    //Maximum percentage of buying power that can be spent on a particular stock at once
    MAX_BUYING_POWER_AT_ONCE: 0.2,
    //Multiplier to calculate the take profit price for bracket orders (ask price * LIMIT_PRICE_MULT = limit_price)
    LIMIT_PRICE_MULT: 1.1,
    //Multiplier to calculate the stop price (ask price * STOP_PRICE_MULT = stop_price)
    STOP_PRICE_MULT: 0.95,
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

const assets = await request("assets", API.PAPER, {
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
        await request("positions", API.PAPER, {
            method: "DELETE",
            params: {
                cancel_orders: true
            }
        });
    }, cleanupTime.valueOf - now.valueOf);
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
        const ask = snapshot.latestQuote.ap;

        //sometimes minute bar is not available
        if(ask < PARAMS.MIN_PRICE || !snapshot.minuteBar) {
            continue;
        }

        const lastAsk = lastSnapshots[symbol].latestQuote.ap;

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

    const account = await request("account", API.PAPER);
    const equity = parseFloat(account.equity);
    const buyingPower = parseFloat(account.cash);

    for(const [symbol, stock] of Object.entries(stocks)) {
        const curPosition = await request(`positions/${symbol}`, API.PAPER);

        if(curPosition.market_value / equity >= PARAMS.MAX_PERCENTAGE_PER_STOCK) {
            continue;
        }

        //$ amount to buy
        let notional = toDollars(Math.min(buyingPower * PARAMS.MAX_BUYING_POWER_AT_ONCE, stock.volume * stock.ask * PARAMS.SPEND_MULT));

        if(moneySpent + notional >= PARAMS.MAX_PER_DAY) {
            notional = PARAMS.MAX_PER_DAY - moneySpent;

            moneySpent = PARAMS.MAX_PER_DAY;

            if(notional === 0) {
                break;
            }
        }else {
            moneySpent += notional;
        }

        await request("orders", API.PAPER, {
            method: "POST",
            body: JSON.stringify({
                symbol,
                notional,
                side: "buy",
                type: "market",
                time_in_force: "day",
                order_class: "bracket",
                take_profit : {
                    limit_price: toDollars(stock.ask * PARAMS.LIMIT_PRICE_MULT)
                },
                stop_loss: {
                    stop_price: toDollars(stock.ask * PARAMS.STOP_PRICE_MULT)
                }
            })
        });

        //no need to wait for a response to do the next order
        await ratelimiter.consume();
        noRatelimitRequest("orders", API.PAPER, {
            method: "POST",
            body: JSON.stringify({
                symbol,
                notional,
                side: "sell",
                type: "trailing_stop",
                time_in_force: "day",
                trail_percent: PARAMS.TRAILING_STOP_PERCENT
            })
        });

        if(moneySpent === PARAMS.MAX_PER_DAY) {
            break;
        }
    }

    if(moneySpent === PARAMS.MAX_PER_DAY) {
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