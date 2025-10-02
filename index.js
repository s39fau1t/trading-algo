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

const ratelimiter = new Ratelimiter(RATELIMIT_MAX_REQ, RATELIMIT_TIMESPAN);

async function request(path, type, options = {
    params: {},
    method: "GET"
}) {
    await ratelimiter.consume();

    const res = await fetch(`https://${type}.${API.DOMAIN}/${path}?${new URLSearchParams(options.params).toString()}`, {
        method: options.method,
        headers: {
            accept: "application/json",
            "APCA-API-KEY-ID": API.KEY,
            "APCA-API-SECRET-KEY": API.SECRET
        }
    });

    /*
    TODO: look at these headers for possibly more efficient ratelimiting
    console.log(res.headers.get("X-RateLimit-Limit"));
    console.log(res.headers.get("X-RateLimit-Remaining"));
    console.log(res.headers.get("X-RateLimit-Reset"));
    */

    return await res.json();
}

const assets = await request("assets", API.PAPER, {
    params: {
        status: "active",
        asset_class: "us_equity"
    }
});

const symbols = assets.filter(asset => asset.tradable && (asset.exchange === "NYSE")).map(asset => asset.symbol);

async function algo(lastSnapshots) {
    //TODO: check time

    const snapshots = await request("stocks/snapshots", API.DATA, {
        params: {
            symbols
        }
    });

    const stocks = [];

    for(const [symbol, snapshot] of Object.entries(snapshots)) {
        const ask = snapshot.latestQuote.ap;

        if(ask < 5) {
            continue;
        }

        const lastAsk = lastSnapshots[symbol].latestQuote.ap;

        stocks.push({
            symbol,
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

    for(const [symbol, stock] of Object.entries(stocks)) {
        //calculate how much to buy
    }
}

setInterval(algo, 10 * 60 * 1000, await request("stocks/snapshots", API.DATA, {
    params: {
        symbols
    }
}));