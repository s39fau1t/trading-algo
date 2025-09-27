//TODO: use alpaca library @alpacahq/alpaca-trade-api

//alpaca paper trading
//key: PKF2GCQC43DWPXMO8VQS
//secret: kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO

//API constants
const domain = "https://paper-api.alpaca.markets";
const key = "PKF2GCQC43DWPXMO8VQS";
const secret = "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO";

const res = await fetch(`${domain}/v2/account`, {
    headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
    }
});

console.log(res.ok);
console.log(await res.json());