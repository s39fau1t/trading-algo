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
- **One trade per ticker per day**: The bot tracks which symbols have been traded each day (ET calendar) and will not place a second trade on the same ticker, even if the position was closed. This prevents overtrading and helps manage risk.
- Trading window: The bot only begins placing trades from market open + LOOKBACK_MINUTES (default 9:30 AM ET + 10 min = 9:40 AM ET). If you adjust LOOKBACK_MINUTES, the start time shifts accordingly.
- Off-hours enforcement: From 3:30 PM ET until the next 9:40 AM ET, the bot enforces a flat state:
  - All positions are closed first, then any remaining open orders are canceled.
  - No positions or open orders are allowed and no new trades are placed.
  - Trading auto-resumes at 9:40 AM ET unless you manually paused it; "pump" cannot override the off-hours restriction.
- Option-first strategy with custom exits:
  - For each candidate symbol, the bot first attempts to buy the nearest-expiry ITM call contract (strike <= target) sized by available per-trade budget. If it can’t, it falls back to equity shares.
  - After a buy fills, it immediately places three exit legs:
    - Stop loss: stop order at STOP_PRICE_MULT of filled price.
    - Trailing stop: trailing_stop with TRAILING_STOP_PERCENT.
    - Take profit: limit order at TAKE_PROFIT_PERCENT above entry.
  - A background monitor cancels the two sibling exits when one exit fills (OCO-like behavior). Trailing stop placement is retried to improve reliability.
- Breakeven stop adjustment (equities):
  - After an equity buy fills, if the stock’s price rises by $0.50 above the filled price, the bot automatically updates the stop loss to the entry price (breakeven) to prevent losses on that position. The delta is configurable via PARAMS.BREAKEVEN_TRIGGER_DELTA.
- Exposure and sizing:
  - A single cap controls both per-trade spend and per-symbol exposure: MAX_TRADE_PCT_OF_INITIAL_BP (default 3% of the day’s initial buying power).
  - Per-symbol exposure cap is computed by underlying and includes both equity and options market value.
  - Per-iteration and per-trade budgets respect:
    - Initial day buying power snapshot (resets on ET date change),
    - The 3% cap per trade and per underlying,
    - Daily cap MAX_PER_DAY,
    - Liquidity cap based on minute volume and price (SPEND_MULT).
  - Quantities are whole numbers only (whole shares, whole option contracts).
- Data feed and lookback:
  - Uses IEX feed for snapshots and 1-minute bars to avoid SIP restrictions.
  - Percent change is computed from the current ask versus a bar approximately LOOKBACK_MINUTES ago, allowing frequent iterations without waiting.
- Timing and scheduling:
  - Uses US/Eastern time for all scheduling.
  - A cleanup scheduler targets 3:30 PM ET; enforceOffHours also runs each iteration to ensure the account remains flat during off-hours.
  - Default iteration interval is 30 seconds (PARAMS.INTERVAL). A simple countdown is shown; in interactive mode the display avoids overwriting your input.
- Rate limiting: A simple token bucket (200 req/min) throttles all API calls.
- Ensure your account has sufficient buying power and that paper trading is enabled.
- Stop the program with Ctrl+C.
