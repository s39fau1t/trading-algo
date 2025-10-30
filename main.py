# TODO
from ib_async import *

import json
import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo
from argparse import ArgumentParser

import contract

# TODO: we should utilize multithreading to get the most out of cpu

# TODO: toml config?
PARAMS = {
    # Interval between each iteration of the algo (seconds)
    'INTERVAL': 10 * 60,
    # Max money spent per day (dollars)
    'MAX_PER_DAY': 2000,
    # Minimum price of a stock before consider buying it (dollars)
    'MIN_PRICE': 5,
    # Maximum percentage of the portfolio that can be one stock
    'MAX_PERCENTAGE_PER_STOCK': 0.03,
    # Multiplier for the amount to spend on a particular stock
    'SPEND_MULT': 0.05,
    # Maximum percentage of buying power that can be spent on a particular stock at once
    'MAX_BUYING_POWER_AT_ONCE': 0.02,
    # TODO
    # Multiplier to calculate the take profit price for bracket orders (ask price * LIMIT_PRICE_MULT = limit_price)
    'LIMIT_PRICE_MULT': 1.1,
    # Multiplier to calculate the stop price (ask price * STOP_PRICE_MULT = stop_price)
    'STOP_PRICE_MULT': 0.995,
    # Percent away from the highest water mark for trailing stop orders
    'TRAILING_STOP_PERCENT': 1,
    # Time to cancel all orders and close out of all positions (24-hr, eastern time)
    'CLOSING': {
        'HOURS': 15,
        'MINUTES': 30
    }
}

# TODO: errors?
def get_account_value(account: list[AccountValue], tag: str):
    for value in account:
        if value.tag == tag:
            return value.value

def get_position(positions: list[Position], symbol: str):
    for position in positions:
        if position.contract.symbol == symbol:
            return position.position

def get_time_est():
    return datetime.now(ZoneInfo('US/Eastern'))

async def cleanup(ib: IB):
    now = get_time_est()
    cleanup_time = now.replace(
        hour=PARAMS['CLOSING']['HOURS'],
        minute=PARAMS['CLOSING']['MINUTES']
    )

    # timestamp is in ms, convert to s for sleep
    await asyncio.sleep((cleanup_time.timestamp - now.timestamp) / 1000)

    # cancel all orders
    ib.reqGlobalCancel()

    positions = ib.positions()
    for position in positions:
        sell_order = Order(
            action='SELL',
            orderType='MKT',
            totalQuantity=position.position
        )

        ib.placeOrder(position.contract, sell_order)

#TODO
async def algo(ib: IB, contracts: list[Contract]):
    stop = False

    now = get_time_est()

    if now.hour == PARAMS['CLOSING']['HOURS'] and now.minute + PARAMS['INTERVAL'] / 60 >= PARAMS['CLOSING']['MINUTES']:
        stop = True

    account_name, = ib.managedAccounts()

    positions = ib.positions(account_name)

    for contract in contracts:
        # request account and market data simultaneously to save time
        account, (ticker,) = await asyncio.gather(
            ib.accountSummaryAsync(account_name),
            ib.reqTickersAsync(contract)
        )

        buying_power = float(get_account_value(account, 'BuyingPower'))
        equity = float(get_account_value(account, 'TotalCashValue'))

        # estimate the current value of the position in dollars
        position_value = get_position(positions, contract.symbol) or 0 * ticker.marketPrice()

        notional = min(
            ticker.volume * ticker.ask * PARAMS['SPEND_MULT'],
            buying_power * PARAMS['MAX_BUYING_POWER_AT_ONCE']
        )

        max_dollars = equity * PARAMS['MAX_PERCENTAGE_PER_STOCK']

        if position_value + notional > max_dollars:
            notional = max_dollars - position_value

        qty = int(notional / ticker.marketPrice())

        if qty == 0:
            continue

        # TODO: MAX_PER_DAY

        # place bracket order

        # https://interactivebrokers.github.io/tws-api/available_orders.html

        parent = Order(
            action='BUY',
            #orderType='MKT',
            orderType='LMT',
            totalQuantity=qty,
            # TODO
            lmtPrice=ticker.ask,
            orderId=ib.client.getReqId(),
            transmit=False
        )

        take_profit = Order(
            action='SELL',
            orderType='LMT',
            totalQuantity=qty,
            lmtPrice=round(ticker.ask * PARAMS['LIMIT_PRICE_MULT'], 2),
            parentId=parent.orderId,
            transmit=False
        )

        trailing_stop = Order(
            action='SELL',
            orderType='TRAIL',
            totalQuantity=qty,
            trailingPercent=PARAMS['TRAILING_STOP_PERCENT'],
            #trailStopPrice=?
            parentId=parent.orderId,
            transmit=True
        )

        ib.placeOrder(contract, parent)
        ib.placeOrder(contract, take_profit)
        ib.placeOrder(contract, trailing_stop)

    if stop:
        await cleanup(ib)

    return stop

async def main(contracts: list[Contract], port: int):
    ib = IB()
    await ib.connectAsync(port=port)

    # use delayed data
    ib.reqMarketDataType(3)

    looping = True

    while looping:
        # TODO: this will loop an extra time on the last iteration
        looping = await asyncio.gather(algo(ib, contracts), asyncio.sleep(PARAMS['INTERVAL']))

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

try:
    contracts = contract.read_contracts('contracts.json')
except FileNotFoundError:
    print('no contract cache, requesting contracts (this may take a while)')

    contracts = contract.get_contracts(port)

    contract.save_contracts('contracts.json', contracts)

print('starting algo...')

asyncio.run(main(contracts, port))