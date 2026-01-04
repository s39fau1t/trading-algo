from ib_async import *

import urllib
import json
from datetime import datetime
import logging
import sys

import connect

FILENAME = 'contracts.json'

def get_symbols() -> list[str]:
    symbols = []
    url = 'https://api.massive.com/v3/reference/tickers?market=stocks&exchange=XNAS&type=CS&active=true&order=asc&limit=1000&sort=ticker&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'

    while True:
        res = json.loads(urllib.request.urlopen(urllib.request.Request(url)).read())

        symbols += res['results']

        if 'next_url' not in res:
            break

        url = f'{res['next_url']}&apiKey=oQKFTzYK6JJpPfGiXleC3655nFo8e3r4'
    
    return [obj['ticker'].replace('.', ' ') for obj in symbols]

def ticker_filled(ticker: Ticker) -> bool:
    # value == value is only false when value = nan
    return ticker.close == ticker.close and ticker.avVolume == ticker.avVolume and ticker.fundamentalRatios is not None

def get_tickers(ib: IB, contracts: list[Contract]) -> list[Ticker | None]:
    # seconds
    TIMEOUT = 10

    tickers = []

    # request data for the batch
    for contract in contracts:
        tickers.append(ib.reqMktData(contract, genericTickList='165,258'))
    
    start = datetime.now()

    # check relevant data has been filled (or timeout has been reached)
    for i, ticker in enumerate(tickers):
        while not ticker_filled(ticker) and datetime.now().timestamp() - start.timestamp() < TIMEOUT:
            ib.sleep()
        
        if not ticker_filled(ticker):
            tickers[i] = None
        
        ib.cancelMktData(ticker.contract)

    return tickers

def get_tickers_batched(ib: IB, contracts: list[Contract]) -> list[Ticker | None]:
    BATCH_SIZE = 90

    tickers = []

    i = 0
    while i < len(contracts):
        batch = get_tickers(ib, contracts[i:min(i + BATCH_SIZE, len(contracts))])

        tickers += batch

        i += BATCH_SIZE

        ib.sleep(1.5)
    
    return tickers

if __name__ == '__main__':
    # connect to ib
    ib = connect.new_api_connection(readonly=True)
    if ib is None:
        sys.exit()

    ib.reqMarketDataType(3)
    util.logToConsole(logging.CRITICAL)

    # get symbols
    symbols = get_symbols()

    # make contracts
    contracts = ib.qualifyContracts(*[Stock(symbol, 'SMART', 'USD') for symbol in symbols])
    contracts = [contract for contract in contracts if contract is not None]

    # batch request data (groups of 90, generic ticks)
    tickers = get_tickers_batched(ib, contracts)
    tickers = [ticker for ticker in tickers if ticker is not None and hasattr(ticker.fundamentalRatios, 'MKTCAP')]

    # filter based on that
    contracts = [ticker.contract for ticker in tickers if ticker.close > 10 and ticker.avVolume * 100 > 1_000_000 and ticker.fundamentalRatios.MKTCAP * 1_000_000 > 300_000_000]

    # save to file
    with open(FILENAME, 'w') as file:
        json.dump([contract.__dict__ for contract in contracts], file)

    ib.disconnect()