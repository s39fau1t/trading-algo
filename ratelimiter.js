export default class Ratelimiter {
    //Max number of tokens/ms
    constructor(maxTokens, timeSpan) {
        this.maxTokens = maxTokens;
        this.timeSpan = timeSpan;
        this.tokens = 0;
        this.start = 0;
    }

    consume() {
        return new Promise((resolve) => {
            const now = Date.now();

            if (now - this.start >= this.timeSpan) {
                this.start = now;
                this.tokens = 0;
            }

            if (++this.tokens <= this.maxTokens) {
                resolve();
            } else {
                const delay = Math.max(0, this.start + this.timeSpan - now);
                setTimeout(() => {
                    // Retry after window resets; resolve only when allowed
                    this.consume().then(resolve);
                }, delay);
            }
        });
    }
}