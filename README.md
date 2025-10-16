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
- "dump it": Immediately close all open positions, then cancel any remaining open orders, and pause new trades/orders. The program keeps running.
- "pump it": Resume placing trades/orders. Previously closed positions are not reinstated.

Notes:
- The bot computes % change using historical 1‑minute bars from 10 minutes ago (configurable via PARAMS.LOOKBACK_MINUTES) against the current ask, so it can evaluate and trade every minute without waiting 10 minutes between iterations.
- Default iteration interval is 60 seconds (PARAMS.INTERVAL). Adjust if needed based on your API subscription and rate limits.
- The bot uses US/Eastern time and will attempt to close positions at the configured CLOSING time.
- Ensure your account has sufficient buying power and that paper trading is enabled.
- Equity orders are placed using whole-share quantities only (no fractional shares). Option orders are whole contracts.
- Stop the program with Ctrl+C.
