# Trading Algo — How to Run

Prerequisites:
- Node.js 18+ (required for global fetch and top‑level await)
- An Alpaca Paper Trading account and API keys

Setup:
1. Clone the repo and open the project directory.
2. (Optional) Replace the hardcoded API.KEY and API.SECRET in index.js with your own paper keys. (The current API.KEY and API.SECRET are that of Milo's paper trading account)
3. Install dependencies (none required, but this ensures tooling is ready):
   ```
   npm install
   ```

Run:
- Start the bot:
  ```
  npm start
  ```
  or
  ```
  node index.js
  ```

Interactive commands (type in the same terminal and press Enter):
- "dump": Immediately close all open positions, then cancel any remaining open orders, and pause new trades/orders. The program keeps running.
- "pump": Resume placing trades/orders. Previously closed positions are not reinstated.

Notes:
- Dynamic per-ticker top-ups: The bot may add exposure to the same ticker across iterations if capacity remains. There is no “one trade per ticker per day” gate anymore. All trades still respect per-symbol exposure and liquidity caps.
- Trading window: The bot only begins placing trades from market open + LOOKBACK_MINUTES (default 9:30 AM ET + 10 min = 9:40 AM ET). If you adjust LOOKBACK_MINUTES, the start time shifts accordingly.
- Off-hours enforcement: From 3:30 PM ET until the next 9:40 AM ET, the bot enforces a flat state:
  - All positions are closed first, then any remaining open orders are canceled.
  - No positions or open orders are allowed and no new trades are placed.
  - Trading auto-resumes at 9:40 AM ET unless you manually paused it; "pump" cannot override the off-hours restriction.
- Hybrid options + equity with custom exits:
  - For each candidate ticker, the planner maximizes dollar spend under the smallest of: per-ticker exposure cap (MAX_TRADE_PCT_OF_INITIAL_BP of initial buying power), daily remaining budget, and liquidity cap (minute volume × price × SPEND_MULT).
  - It tries a near-ITM call (nearest expiry, strike <= target) and combines contracts with shares to best fit the cap (whole contracts/shares only). If options are not viable, it uses shares only.
  - After a buy fills, it immediately places three exit legs:
    - Stop loss: stop at STOP_PRICE_MULT of entry.
    - Trailing stop: trailing_stop with fixed $ trail (PARAMS.TRAILING_STOP_DOLLARS).
    - Take profit: limit at TAKE_PROFIT_PERCENT above entry.
  - An OCO monitor cancels siblings when one fills; trailing stop placement is retried for reliability.
- Breakeven stop adjustment (equities):
  - After an equity buy fills, if the price rises by BREAKEVEN_TRIGGER_DELTA above entry, the stop loss is moved to breakeven.
- Exposure and sizing:
  - A single cap controls both per-trade spend and per-symbol exposure: MAX_TRADE_PCT_OF_INITIAL_BP (default 3% of the day’s initial buying power).
  - Exposure is tracked by underlying (equity + options market value) and includes pending allocations within the current batch.
  - Liquidity cap: minute volume × ask × SPEND_MULT.
  - Quantities are whole numbers only (whole shares and whole option contracts).
- Data feed and lookback:
  - Uses IEX feed for snapshots and 1-minute bars; percent change is computed versus approximately LOOKBACK_MINUTES ago.
- Timing and scheduling:
  - Uses US/Eastern time for all scheduling. A cleanup scheduler targets 3:30 PM ET; enforceOffHours also runs each iteration to keep the account flat during off-hours.
  - Default iteration interval is 30 seconds (PARAMS.INTERVAL). A simple countdown is shown; interactive mode avoids overwriting your input.
- Rate limiting: A token bucket (200 req/min) throttles all API calls.
- Ensure your account has sufficient buying power and that paper trading is enabled.
- Stop the program with Ctrl+C.
- 10-minute non-profit exit:
  - For every new trade (equity or option), a one-time check runs NON_PROFIT_TIMEOUT_MINUTES after fill; if unrealized P/L <= 0, open exits are canceled and the position is closed at market.
- Iteration allocation and concurrency:
  - Each iteration plans a batch of buys and submits them concurrently, possibly in small waves to consume residual budget.
  - Hybrid per-ticker planning may produce multiple legs (option + equity) for the same ticker within a batch to maximize spend while respecting exposure and liquidity caps.
