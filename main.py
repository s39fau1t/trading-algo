from ib_async import *

import json
import asyncio

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

# TODO: is a separate script needed??
# TODO: where put this
# TODO: what to do when file does not exist?
with open('contracts.json') as file:
    contracts = [Contract(**obj) for obj in json.load(file)]

# TODO: errors?
def get_account_value(account, tag):
    for value in account:
        if value.tag == tag:
            return value.value

def get_position(positions, symbol):
    for position in positions:
        if position.contract.symbol == symbol:
            return position.position

#TODO
async def algo(ib: IB):
    # TODO: stopping, cleanup

    account_name, = ib.managedAccounts()
    account = await ib.accountSummaryAsync(account_name)

    buying_power = float(get_account_value(account, 'BuyingPower'))
    equity = float(get_account_value(account, 'TotalCashValue'))

    for contract in contracts:
        positions = ib.positions(account_name)
        cur_position = get_position(positions, contract.symbol)

        # TODO: check PARAMS['MAX_PERCENTAGE_PER_STOCK']

        ticker, = await ib.reqTickers(contract)

        notional = min(
            ticker.volume * ticker.ask * PARAMS['SPEND_MULT'],
            buying_power * PARAMS['MAX_BUYING_POWER_AT_ONCE']
        )

        qty = notional / ticker.marketPrice()

        # TODO: MAX_PER_DAY

        # place bracket order
        # TODO: fractional??

        # https://interactivebrokers.github.io/tws-api/available_orders.html

        parent = Order(
            action='BUY',
            orderType='MKT',
            totalQuantity=qty,
            orderId=ib.client.getReqId(),
            transmit=False
        )

        take_profit = Order(
            action='SELL',
            orderType='LMT',
            totalQuantity=qty,
            lmtPrice=ticker.ask * PARAMS['LIMIT_PRICE_MULT'],
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

    return True

async def loop():
    ib = IB()
    # TODO: let user select port
    await ib.connectAsync(port=7497)

    # use delayed data
    ib.reqMarketDataType(3)

    looping = True

    while looping:
        looping = await asyncio.gather(algo(ib), asyncio.sleep(PARAMS['INTERVAL']))

asyncio.run(loop())