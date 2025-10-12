from ib_async import *

import urllib.request
import json

# get symbols through alpaca web API (possibly change in the future)
def get_symbols():
    req = urllib.request.Request("https://paper-api.alpaca.markets/v2/assets?asset_class=us_equity&exchange=NYSE", headers={
        "accept": "application/json",
        "APCA-API-KEY-ID": "PKF2GCQC43DWPXMO8VQS",
        "APCA-API-SECRET-KEY": "kKf6mS70NWynKQeu7IgA0F3scyXPqUAeOfZ3OcXO"
    })

    symbols = json.loads(urllib.request.urlopen(req).read())

    return [x["symbol"] for x in symbols]

print(get_symbols())

"""
ib = IB()
ib.connect('127.0.0.1', 7497, clientId=1)

symbols = ib.reqMatchingSymbols('AAPL')
print(symbols)

ib.disconnect()
"""