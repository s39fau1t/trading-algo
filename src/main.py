from ib_async import *

import tomllib
import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo
from argparse import ArgumentParser

import contract

# TODO: figure out ask vs market_price vs bid??

# TODO: CLI (seperate processes)

# get config (we want this to be global)
with open('config.toml', 'rb') as file:
    config = tomllib.load(file)

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
        hour=config['closing'].hour,
        minute=config['closing'].minute
    )

    await asyncio.sleep(cleanup_time.timestamp() - now.timestamp())

    # cancel all orders
    ib.reqGlobalCancel()

    # TODO: is this needed?
    await asyncio.sleep(5)

    positions = ib.positions()
    for position in positions:
        sell_order = Order(
            action='SELL',
            orderType='MKT',
            totalQuantity=position.position
        )

        ib.placeOrder(position.contract, sell_order)
    
    # TODO: await orders filling

#TODO
async def algo(ib: IB, contracts: list[Contract], prev_snapshots: dict[Ticker], money_spent: float):
    stop = False

    now = get_time_est()
    if now.hour == config['closing'].hour and now.minute + config['interval'] >= config['closing'].minute:
        stop = True
    
    account_name, = ib.managedAccounts()
    positions = ib.positions(account_name)

    tickers = await ib.reqTickersAsync(*contracts)

    to_buy = [ticker for ticker in tickers if prev_snapshots[ticker.contract.symbol].ask > 0 and ticker.ask >= config['min_price']]
    to_buy.sort(key=lambda ticker: (ticker.ask - prev_snapshots[ticker.contract.symbol].ask) / prev_snapshots[ticker.contract.symbol], reverse=True)

    for ticker in to_buy:
        account = ib.accountValues(account_name)

        # TODO: use cash or settled cash?
        buying_power = float(get_account_value(account, 'TotalCashBalance'))
        equity = float(get_account_value(account, 'TotalCashValue'))

        # estimate the current value of the position in dollars
        position_value = get_position(positions, contract.symbol) or 0 * ticker.marketPrice()

        notional = min(
            ticker.volume * ticker.ask * config['spend_mult'],
            buying_power * config['max_buying_power_at_once']
        )

        stock_max_dollars = equity * config['max_percentage_per_stock']

        # TODO: should these be together
        if position_value + notional > stock_max_dollars or money_spent + notional > config['max_per_day']:
            notional = min(stock_max_dollars - position_value, config['max_per_day'] - money_spent)

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
            lmtPrice=round(ticker.ask * config['limit_price_mult'], 2),
            parentId=parent.orderId,
            transmit=False
        )

        trailing_stop = Order(
            action='SELL',
            orderType='TRAIL',
            totalQuantity=qty,
            trailingPercent=config['trailing_stop_percent'],
            parentId=parent.orderId,
            transmit=True
        )

        ib.placeOrder(contract, parent)
        ib.placeOrder(contract, take_profit)
        ib.placeOrder(contract, trailing_stop)

        if money_spent + config['min_price'] > config['max_per_day']:
            stop = True
            break

    if stop:
        print('cleaning up')

        await cleanup(ib)

    return (stop, {ticker.contract.symbol: ticker for ticker in tickers}, money_spent)

async def main(contracts: list[Contract], port: int):
    ib = IB()
    await ib.connectAsync(port=port)

    # use delayed data
    ib.reqMarketDataType(3)

    stop = False
    money_spent = 0
    # TODO: use historical data so we don't need to wait
    prev_snapshots = await ib.reqTickersAsync(*contracts)
    await asyncio.sleep(config['interval'] * 60)

    while not stop:
        # TODO: this will loop an extra time on the last iteration
        # convert config['interval'] to seconds for sleep
        (stop, prev_snapshots, money_spent), = await asyncio.gather(
            algo(ib, contracts, prev_snapshots, money_spent),
            asyncio.sleep(config['interval'] * 60)
        )

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
    contracts = contract.read_contracts()
except FileNotFoundError:
    print('no contract cache, requesting contracts (this may take a while)')

    contracts = contract.get_contracts(port)

    contract.save_contracts(contracts)

print('starting algo...')

asyncio.run(main(contracts, port))