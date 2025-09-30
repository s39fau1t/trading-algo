export default class Ratelimiter {
    //Max number of tokens/ms
    constructor(maxTokens, timeSpan) {
        this.maxTokens = maxTokens;
        this.timeSpan = timeSpan;
        this.tokens = 0;
        this.start = 0;
    }

    consume() {
        return new Promise(resolve => {
            const curTime = Date.now();

            if(curTime - this.start >= this.timeSpan) {
                this.start = curTime;
                this.tokens = 0;
            }

            if(++this.tokens <= this.maxTokens) {
                resolve();
            }else {
                console.log("waiting");
                setTimeout(() => {
                    this.consume();

                    resolve();
                }, this.start + this.timeSpan - curTime);
            }
        });
    }
}