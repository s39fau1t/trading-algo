from ib_async import IB, Contract, Stock, util

import urllib.request
import json
import logging
import sys

DEFAULT_PORTS = [
    {
        'name': 'TWS live trading',
        'port': 7496,
        'live': False
    },
    {
        'name': 'IB Gateway live trading',
        'port': 4001,
        'live': True
    },
    {
        'name': 'TWS paper trading',
        'port': 7497,
        'live': False
    },
    {
        'name': 'IB Gateway paper trading',
        'port': 4002,
        'live': True
    }
]

FILENAME = 'contracts.json'

def get_symbols():
    symbols = []
    url = 'https://api.massive.com/v3/reference/tickers?market=stocks&exchange=XNYS&type=CS&active=true&order=asc&limit=1000&sort=ticker&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'

    while True:
        res = json.loads(urllib.request.urlopen(urllib.request.Request(url)).read())

        symbols += res['results']

        if 'next_url' not in res:
            break

        url = f'{res['next_url']}&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'
    
    return [obj['ticker'].replace('.', ' ') for obj in symbols]

def get_contracts(ib: IB):
    symbols = get_symbols()

    contracts = ib.qualifyContracts(*[Stock(symbol, 'SMART', 'USD') for symbol in symbols])

    return [contract for contract in contracts if contract is not None]

def save_contracts(contracts: list[Contract]):
    with open(FILENAME, 'w') as file:
        # TODO: only include essential properties
        json.dump([contract.__dict__ for contract in contracts], file)

def read_contracts():
    with open(FILENAME) as file:
        contracts = [Contract(**obj) for obj in json.load(file)]
    
    return contracts

if __name__ == '__main__':
    ib = IB()

    util.logToConsole(logging.CRITICAL)

    for port in DEFAULT_PORTS:
            try:
                ib.connect(port=port['port'])

                break
            except:
                pass

    if not ib.isConnected():
        print('failed to connect; make sure TWS or IB Gateway is open and configured for API use')

        sys.exit()

    contracts = get_contracts(ib)

    save_contracts(contracts)

    ib.disconnect()