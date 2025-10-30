from ib_async import IB, Contract, Stock

import urllib.request
import json
from argparse import ArgumentParser
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

def get_contracts(port: int):
    ib = IB()
    ib.connect(port=port)

    ib._logger.setLevel(logging.CRITICAL)
    ib.client._logger.setLevel(logging.CRITICAL)
    ib.wrapper._logger.setLevel(logging.CRITICAL)

    symbols = get_symbols()

    contracts = ib.qualifyContracts(*[Stock(symbol, 'SMART', 'USD') for symbol in symbols])

    ib.disconnect()

    return [contract for contract in contracts if contract is not None]

def save_contracts(path: str, contracts: list[Contract]):
    with open(path, 'w') as file:
        # TODO: only include essential properties
        json.dump([contract.__dict__ for contract in contracts], file)

def read_contracts(path: str):
    with open(path) as file:
        contracts = [Contract(**obj) for obj in json.load(file)]
    
    return contracts

if __name__ == '__main__':
    # Get the port from command line args
    parser = ArgumentParser(prog='uv run main.py', epilog='Note: Port argument must match with whatever is selected in TWS otherwise it will not connect')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--live', action='store_true', help='connect to TWS over the default live trading port')
    group.add_argument('--paper', action='store_true', help='connect to TWS over the default paper trading port')
    group.add_argument('--port', type=int, help='connect to TWS over a custom port')

    args = parser.parse_args()
    if args.live:
        port = 7496
    elif args.paper:
        port = 7497
    else:
        port = args.port

    contracts = get_contracts(port)

    save_contracts('contracts.json', contracts)