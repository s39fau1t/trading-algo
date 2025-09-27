//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

import Alpaca from "@alpacahq/alpaca-trade-api";

const alpaca = new Alpaca({
    keyId: "PKF2GCQC43DWPXMO8VQS",
    secretKey: "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO",
    paper: true
});

console.log(await alpaca.getAccount());

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