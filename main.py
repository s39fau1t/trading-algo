# TODO
from ib_async import *

import json
import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo
from argparse import ArgumentParser

import contract

# TODO: we should utilize multithreading to get the most out of cpu

# TODO: figure out ask vs market_price vs bid??

# TODO: rounding for dollar amounts??

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
    # Multiplier to calculate the take profit price for bracket orders (ask price * LIMIT_PRICE_MULT = limit_price)
    'LIMIT_PRICE_MULT': 1.1,
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
    await asyncio.sleep((cleanup_time.timestamp() - now.timestamp()) / 1000)

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
async def algo(ib: IB, contracts: list[Contract], money_spent: float):
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

        # TODO: use buying power or cash?
        buying_power = float(get_account_value(account, 'BuyingPower'))
        equity = float(get_account_value(account, 'TotalCashValue'))

        # estimate the current value of the position in dollars
        position_value = get_position(positions, contract.symbol) or 0 * ticker.marketPrice()

        notional = min(
            ticker.volume * ticker.ask * PARAMS['SPEND_MULT'],
            buying_power * PARAMS['MAX_BUYING_POWER_AT_ONCE']
        )

        stock_max_dollars = equity * PARAMS['MAX_PERCENTAGE_PER_STOCK']

        # TODO: should these be together
        if position_value + notional > stock_max_dollars or money_spent + notional > PARAMS['MAX_PER_DAY']:
            notional = min(stock_max_dollars - position_value, PARAMS['MAX_PER_DAY'] - money_spent)

        qty = int(notional / ticker.marketPrice())

        # also ensures we don't go over MAX_PER_DAY
        if qty == 0:
            continue

        # worst case money spent; TODO: is that right?
        money_spent += round(qty * ticker.ask, 2)

        print(f'buying {qty} shares of {contract.symbol} with estimated spending {qty * ticker.ask} and current total spending {money_spent}')

        # place bracket order
        # https://interactivebrokers.github.io/tws-api/available_orders.html

        parent = Order(
            action='BUY',
            orderType='LMT',
            totalQuantity=qty,
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
            parentId=parent.orderId,
            transmit=True
        )

        ib.placeOrder(contract, parent)
        ib.placeOrder(contract, take_profit)
        ib.placeOrder(contract, trailing_stop)

        if money_spent + PARAMS['MIN_PRICE'] > PARAMS['MAX_PER_DAY']:
            stop = True
            break

    if stop:
        await cleanup(ib)

    return (stop, money_spent)

async def main(contracts: list[Contract], port: int):
    ib = IB()
    await ib.connectAsync(port=port)

    # use delayed data
    ib.reqMarketDataType(3)

    stop = False
    money_spent = 0

    while not stop:
        # TODO: this will loop an extra time on the last iteration
        (stop, money_spent) = await asyncio.gather(algo(ib, contracts, money_spent), asyncio.sleep(PARAMS['INTERVAL']))

    ib.disconnect()

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

# try to get contracts from cache, if not request them and store in cache
# TODO: when should cache be updated
try:
    contracts = contract.read_contracts('contracts.json')
except FileNotFoundError:
    print('no contract cache, requesting contracts (this may take a while)')

    contracts = contract.get_contracts(port)

    contract.save_contracts('contracts.json', contracts)

print('starting algo...')

asyncio.run(main(contracts, port))