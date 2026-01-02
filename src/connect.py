from ib_async import *

import logging

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

def new_api_connection(live_conf = False, **options) -> IB | None:
    ib = IB()

    util.logToConsole(logging.CRITICAL)

    for port in DEFAULT_PORTS:
        try:
            ib.connect(port=port['port'], **options)

            # live trading confirmation
            if live_conf and port['live']:
                y_n = input('about to connect to live trading, press y to continue\n').lower()

                if y_n not in ['y', 'yes']:
                    ib.disconnect()

                    continue
            break
        except:
            pass

    if not ib.isConnected():
        print('failed to connect; make sure TWS or IB Gateway is open and configured for API use')

        return None

    return ib