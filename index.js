//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

import Alpaca from "@alpacahq/alpaca-trade-api";

const alpaca = new Alpaca({
    keyId: "PKF2GCQC43DWPXMO8VQS",
    secretKey: "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO",
    feed: "iex",
    paper: true
});

const ws = alpaca.data_stream_v2;
ws.connect();
ws.onConnect(() => {
    ws.subscribeForQuotes(["*"]);
});
ws.onStockQuote(quote => {
    console.log(quote);
});

/*
const assets = await alpaca.getAssets({
    status: "active",
    asset_class: "us_equity"
});



//TODO: check the time
while(true) {
    //TODO: fix looping
    //TODO: rate limit
    const symbols = assets.filter(asset => asset.tradable && (asset.exchange === "NYSE" || asset.exchange === "NASDAQ")).map(asset => asset.symbol);

    const prices = await alpaca.getSnapshots(symbols);

    const scanThese = prices.filter(stock => (stock.LatestQuote ?? {AskPrice: -1}).AskPrice > 5);
}
    */

//getsnapshot



//const ws = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");




//

/*
//API constants
const domain = "https://paper-api.alpaca.markets";
const key = "PKF2GCQC43DWPXMO8VQS";
const secret = "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO";

const res = await fetch(`${domain}/v2/assets`, {
    headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
    }
});

console.log(res.ok);

const assets = await res.json();
console.log(assets.length);

for(const asset of assets) {
    if(asset.tradable && !asset.class.toLowerCase().includes("crypto")) {
        console.log(asset);
    }
}
*/