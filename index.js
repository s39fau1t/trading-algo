//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

import Alpaca from "@alpacahq/alpaca-trade-api";

import Ratelimiter from "./ratelimiter.js";

const maxRequests = 200;
const ratelimitTimeSpan = 1 * 60 * 1000;

const ratelimiter = new Ratelimiter(maxRequests, ratelimitTimeSpan);

const alpaca = new Alpaca({
    keyId: "PKF2GCQC43DWPXMO8VQS",
    secretKey: "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO",
    paper: true
});

await ratelimiter.consume();
const assets = await alpaca.getAssets({
    status: "active",
    asset_class: "us_equity"
});

const symbols = assets.filter(asset => asset.tradable && (asset.exchange === "NYSE")).map(asset => asset.symbol);

await ratelimiter.consume();
const quotes = await alpaca.getLatestQuotes(symbols);