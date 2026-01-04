TWS algo implementation using a custom market scanner `scanner.py`



[uv](https://github.com/astral-sh/uv) is used for dependency management

### To run:
#### 1. Install [uv](https://github.com/astral-sh/uv)
#### 2. Clone repo
```
git clone https://github.com/s39fau1t/trading-algo.git
cd trading-algo
```
#### 3. Switch to ibkr branch
```
git checkout ibkr
cd src
```
#### 4. Start TWS/IB Gateway and [configure for API use](https://www.interactivebrokers.com/campus/trading-lessons/installing-configuring-tws-for-the-api/)
#### 5. Run with uv
```
uv run main.py
```
