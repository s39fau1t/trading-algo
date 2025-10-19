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
  - Liquidity cap: minute volume × ask × SPEND_MULT (applies to equity shares only; options ignore volume-based caps).
  - Quantities are whole numbers only (whole shares and whole option contracts).
  - Per-order enforcement: every buy order is capped so its notional is <= MAX_TRADE_PCT_OF_INITIAL_BP × initial buying power.
- 5% current-volume cap (stocks only):
  - Equity orders must be strictly less than 5% of the stock’s current 1‑minute volume.
  - Option contracts are NOT constrained by current-minute volume; they only adhere to MAX_TRADE_PCT_OF_INITIAL_BP.
  - If minute volume is too low, equity trades are skipped.
  - Per-order enforcement: right before each equity buy is submitted, the order quantity is revalidated and capped so that the single order is strictly below the 5% minute‑volume limit.
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
  - Each iteration plans a batch of buys and submits them in paced “waves” to consume residual budget.
  - Hybrid per‑ticker planning may produce multiple legs (option + equity) for the same ticker in a single iteration.
  - The bot continues waves within the same iteration until remaining buying power (and the daily cap) are exhausted or no further viable trades exist, while respecting API rate limits.

- 10-minute non-profit exit:
  - For every new trade (equity or option), a one-time check runs NON_PROFIT_TIMEOUT_MINUTES after fill; if unrealized P/L <= 0, open exits are canceled and the position is closed at market.

- Rate limiting:
  - Dual token buckets throttle all API calls to both 10 requests/second and 200 requests/minute.
  - Trade submission per wave is sequentially paced to avoid bursty traffic; iterations still run as fast as the limits allow.

- Logging and terminal UX:
  - Logs include ET timestamps.
  - A countdown appears between iterations; in interactive mode, the bot avoids overwriting your input prompt.

- Safety and environment:
  - This is intended for Alpaca Paper Trading. Ensure your paper account (and options permissions) are enabled and has sufficient buying power.
  - API keys are currently hardcoded in index.js for convenience; replace them with your own paper keys and avoid committing real keys.

Configuration quick reference (index.js PARAMS):
- INTERVAL: Iteration interval in ms. Default: 30_000.
- MAX_PER_DAY: Max total dollars to spend per day. Default: 2000.
- MIN_PRICE: Minimum stock price to consider. Default: 5.
- MAX_TRADE_PCT_OF_INITIAL_BP: Fraction of initial day buying power used as both per‑trade and per‑symbol exposure cap. Default: 0.03 (3%).
- SPEND_MULT: Liquidity cap multiplier (minute volume × ask × SPEND_MULT). Default: 0.05.
- LIMIT_PRICE_MULT: Not used for exits (custom exits are used). Kept for reference.
- STOP_PRICE_MULT: Stop loss multiplier of entry. Default: 0.995 (0.5% below).
- TRAILING_STOP_DOLLARS: Fixed $ trailing amount. Default: 0.50.
- TAKE_PROFIT_PERCENT: Take profit percent above entry. Default: 5.
- BREAKEVEN_TRIGGER_DELTA: Equity-only; move stop to entry after this $ advance. Default: 0.50.
- CLOSING: Enforced flat time (ET). Default: 15:30.
- LOOKBACK_MINUTES: Minutes to look back for momentum. Default: 10 (sets start time to 9:30 + LOOKBACK_MINUTES).
- NON_PROFIT_TIMEOUT_MINUTES: Minutes after fill to close if P/L <= 0. Default: 10.

Operational tips:
- Use "dump" any time to flatten immediately and pause trading; the bot stays running.
- Use "pump" to resume trading when allowed; during off-hours, trading still remains paused until the window reopens.
- Stop the program with Ctrl+C.

Troubleshooting:
- If you see non‑JSON API responses, you may be rate‑limited or using the wrong domain/feed. The bot logs the HTTP status and partial body for diagnosis.
- If trailing stops fail intermittently, the bot retries placement automatically; check logs for “Trailing stop placement failed” messages.
- If you enable options, ensure your paper account supports them; otherwise, the planner will fall back to shares-only.
