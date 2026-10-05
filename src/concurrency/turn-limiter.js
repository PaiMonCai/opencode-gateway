/**
 * Bounded process-wide turn concurrency.
 *
 * Conversation locking answers "may two requests mutate the same session at
 * once?". This limiter answers the different question "how many independent
 * turns may consume runtime/upstream capacity at once?". The queue is bounded
 * both by count and by wait time so overload cannot turn into unbounded memory
 * growth or arbitrarily long tail latency.
 *
 * @module concurrency/turn-limiter
 */

/**
 * @typedef {object} TurnWaiter
 * @property {(release: (() => void)|null) => void} resolve
 * @property {boolean} settled
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {AbortSignal|null} signal
 * @property {(() => void)|null} onAbort
 */

/**
 * @typedef {object} TurnLimiterSnapshot
 * @property {number} active
 * @property {number} pending
 * @property {number} maxConcurrent
 * @property {number} maxPending
 * @property {number} waitTimeoutMs
 * @property {number} rejectedTotal
 * @property {number} timedOutTotal
 * @property {number} abortedTotal
 */

/**
 * Create a fair FIFO concurrency limiter.
 *
 * @param {object} [options]
 * @param {number} [options.maxConcurrent] Simultaneous permits.
 * @param {number} [options.maxPending] Maximum queued waiters.
 * @param {number} [options.waitTimeoutMs] Maximum queue wait; zero means fail fast.
 * @returns {{
 *   acquire: (options?: {signal?: AbortSignal|null}) => Promise<(() => void)|null>,
 *   snapshot: () => TurnLimiterSnapshot
 * }}
 */
export function createTurnLimiter({ maxConcurrent = 20, maxPending = 100, waitTimeoutMs = 2000 } = {}) {
    const concurrencyLimit = Math.max(1, Math.floor(Number(maxConcurrent) || 20));
    const pendingLimit = Math.max(0, Math.floor(Number(maxPending) || 0));
    const waitLimit = Math.max(0, Math.floor(Number(waitTimeoutMs) || 0));

    let active = 0;
    let rejectedTotal = 0;
    let timedOutTotal = 0;
    let abortedTotal = 0;

    /** @type {TurnWaiter[]} */
    const queue = [];

    /** @param {TurnWaiter} waiter */
    const removeWaiter = (waiter) => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
    };

    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            active = Math.max(0, active - 1);
            queueMicrotask(drain);
        };
    };

    /**
     * @param {TurnWaiter} waiter
     * @param {(() => void)|null} release
     */
    const settleWaiter = (waiter, release) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        waiter.resolve(release);
    };

    function drain() {
        while (active < concurrencyLimit && queue.length > 0) {
            const waiter = queue.shift();
            if (!waiter || waiter.settled) continue;
            active += 1;
            settleWaiter(waiter, makeRelease());
        }
    }

    /**
     * @param {{signal?: AbortSignal|null}} [options]
     * @returns {Promise<(() => void)|null>}
     */
    const acquire = async (options = {}) => {
        const signal = options.signal ?? null;
        if (signal?.aborted) {
            abortedTotal += 1;
            return null;
        }

        // Do not leapfrog a queued waiter even if a release happened just before
        // its drain microtask ran.
        if (active < concurrencyLimit && queue.length === 0) {
            active += 1;
            return makeRelease();
        }

        if (pendingLimit === 0 || queue.length >= pendingLimit || waitLimit === 0) {
            rejectedTotal += 1;
            return null;
        }

        return new Promise((resolve) => {
            /** @type {TurnWaiter} */
            const waiter = {
                resolve,
                settled: false,
                timer: null,
                signal,
                onAbort: null
            };

            waiter.timer = setTimeout(() => {
                if (waiter.settled) return;
                removeWaiter(waiter);
                timedOutTotal += 1;
                settleWaiter(waiter, null);
            }, waitLimit);
            if (typeof waiter.timer.unref === 'function') waiter.timer.unref();

            if (signal) {
                waiter.onAbort = () => {
                    if (waiter.settled) return;
                    removeWaiter(waiter);
                    abortedTotal += 1;
                    settleWaiter(waiter, null);
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }

            queue.push(waiter);
            drain();
        });
    };

    const snapshot = () => ({
        active,
        pending: queue.filter((waiter) => !waiter.settled).length,
        maxConcurrent: concurrencyLimit,
        maxPending: pendingLimit,
        waitTimeoutMs: waitLimit,
        rejectedTotal,
        timedOutTotal,
        abortedTotal
    });

    return { acquire, snapshot };
}
