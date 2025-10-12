from ib_async import *

import urllib.request
import json
import asyncio

import csv

# get symbols through alpaca web API (possibly change in the future)
def get_symbols():
    req = urllib.request.Request('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity&exchange=NYSE', headers={
        'accept': 'application/json',
        'APCA-API-KEY-ID': 'PKF2GCQC43DWPXMO8VQS',
        'APCA-API-SECRET-KEY': 'kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO'
    })

    data = json.loads(urllib.request.urlopen(req).read())

    return [obj['symbol'].replace('.', ' ') for obj in data if obj['tradable'] == True and '.WS' not in obj['symbol']]

ib = IB()
ib.connect('127.0.0.1', 7497, clientId=1)

ib.reqMarketDataType(3)

symbols = get_symbols()

contracts = ib.qualifyContracts(*[Stock(symbol, 'SMART', 'USD') for symbol in symbols])

# TODO: use alpaca for market data since it's free?
print(ib.reqTickers(contracts[0]))

ib.disconnect()