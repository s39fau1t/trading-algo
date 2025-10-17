from ib_async import *

import json
import asyncio

# initial state
# TODO: global or within async func??
# TODO: let user select port?
ib = IB()
ib.connect(port=7497)

# use delayed data
ib.reqMarketDataType(3)

# TODO: what to do when file does not exist?
with open('contracts.json') as file:
    contracts = json.load(file)

#TODO
async def algo():
    print("looping...")
    return True

async def loop():
    looping = True

    while looping:
        looping = await asyncio.gather(algo(), asyncio.sleep(10 * 60))

asyncio.run(loop())

ib.disconnect()