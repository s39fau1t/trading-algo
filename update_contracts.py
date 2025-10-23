from ib_async import IB, Stock

import urllib.request
import json
import logging

def get_symbols():
    symbols = []
    url = 'https://api.polygon.io/v3/reference/tickers?market=stocks&exchange=XNYS&type=CS&active=true&order=asc&limit=1000&sort=ticker&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'

    while True:
        res = json.loads(urllib.request.urlopen(urllib.request.Request(url)).read())

        symbols += res['results']

        if 'next_url' not in res:
            break

        url = f'{res['next_url']}&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'
    
    return [obj['ticker'].replace('.', ' ') for obj in symbols]

ib = IB()
# TODO: allow user to specify which port to use
ib.connect(port=7497)

ib._logger.setLevel(logging.CRITICAL)
ib.client._logger.setLevel(logging.CRITICAL)
ib.wrapper._logger.setLevel(logging.CRITICAL)

symbols = get_symbols()

contracts = ib.qualifyContracts(*[Stock(symbol, 'SMART', 'USD') for symbol in symbols])

with open('contracts.json', 'w') as file:
    json.dump([contract.__dict__ for contract in contracts if contract != None], file)

ib.disconnect()