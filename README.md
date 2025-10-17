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
- The bot only begins placing trades from 9:40 AM ET (market open + LOOKBACK_MINUTES). If you adjust LOOKBACK_MINUTES, the start time shifts accordingly.
- From 3:30 PM ET until 9:40 AM ET the next trading day, the bot enforces an off-hours state: it closes all positions first and only then cancels any remaining open orders. During this window, no positions or open orders are allowed, and no new trades are placed.
- Each iteration can place multiple trades across the top-ranked symbols. Combined notional for that iteration is capped by remaining initial day buying power minus $5, while still respecting per-symbol exposure, per-trade limits, and the daily MAX_PER_DAY cap.
- The bot computes % change using historical 1‑minute bars from 10 minutes ago (configurable via PARAMS.LOOKBACK_MINUTES) against the current ask, so it can evaluate and trade every minute without waiting 10 minutes between iterations.
- Default iteration interval is 30 seconds (PARAMS.INTERVAL). Adjust if needed based on your API subscription and rate limits.
- The bot uses US/Eastern time and will attempt to close positions at the configured CLOSING time.
- Ensure your account has sufficient buying power and that paper trading is enabled.
- Equity orders are placed using whole-share quantities only (no fractional shares). Option orders are whole contracts.
- "pump" cannot override the off-hours restriction; trading resumes automatically at 9:40 AM ET if not paused manually.
- Stop the program with Ctrl+C.
