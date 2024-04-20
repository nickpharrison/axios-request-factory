
const axios = require('axios').default;

const getValue = async (input) => {
	if (typeof input === 'function') {
		return await input();
	}
	return input;
}

class AxiosRequestFactory {

	constructor(opts) {

		this._opts = opts;

		this.logger = this._opts?.logger ?? console;

		/** @type {number} */
		this._rateLimitUntil = null;

		/** @type {{res: (value: any) => void, rej: (reason: any) => void, axiosConfig: import('axios').AxiosRequestConfig, options: any, failedAttempts: number}[]} */
		this._queue = [];
		/** @type {{res: (value: any) => void, rej: (reason: any) => void, axiosConfig: import('axios').AxiosRequestConfig, options: any, failedAttempts: number}[]} */
		this._specialRetryQueue = [];

		this._currentOngoingRequests = 0;

		this.axios = axios.create(this._opts?.axiosInstanceOptions);

		this._id = createUniqueId(this._opts?.id, this._opts?.axiosInstanceOptions);

	}

	addQueueItemToQueue(obj) {

		if (obj.priority === undefined || typeof obj.priority === 'number') {
			// pass
		} else {
			throw new Error(`Priority ${obj.priority} is not valid for request factory. Must be a number if specified`);
		}

		this._queue.push(obj);

	}

	getNextQueueItem() {
		if (this._specialRetryQueue.length !== 0) {
			return this._specialRetryQueue.shift();
		}
		let currentObj;
		let currentPriority;
		let currentIndex;
		for (let i = 0; i < this._queue.length; i += 1) {
			const obj = this._queue[i];
			const priorty = obj.options?.priority ?? 5;
			if (currentObj === undefined) {
				currentObj = obj;
				currentIndex = i;
				currentPriority = priorty;
				continue;
			}
			if (priorty > currentPriority) {
				currentObj = obj;
				currentIndex = i;
				currentPriority = priorty;
				continue;
			}
		}
		if (currentObj === undefined) {
			return undefined;
		}
		this._queue.splice(currentIndex, 1);
		return currentObj;
	}

	/**
	 * 
	 * @param {import('axios').AxiosRequestConfig} axiosConfig 
	 * @param {{priority: number}} options Priority 9 is high priority and priority 1 is low priority
	 * @returns {Promise<import('axios').AxiosResponse>} 
	 */
	request(axiosConfig, options) {

		return new Promise((res, rej) => {

			if (axiosConfig == null) {
				rej(new Error('Cannot call a factory request with no axiosConfig'));
				return;
			}

			if (options == null) {
				options = {};
			}

			const obj = {res, rej, axiosConfig, options, failedAttempts: 0};

			try {
				this.addQueueItemToQueue(obj);
			} catch (err) {
				rej(err);
			}

			this.triggerNext();

		});

	}

	_updateRateLimit(resp) {

		let millis = Number.parseFloat(resp.headers['retry-after']) * 1000;
		if (!Number.isFinite(millis) || millis < 0) {
			millis = 5000;
		}
		const rateLimitSafetyPeriod = this._opts?.rateLimitSafetyPeriod ?? 500;
		const newRateLimit = Date.now() + millis;
		if (this._rateLimitUntil < newRateLimit) {
			this._rateLimitUntil = newRateLimit + rateLimitSafetyPeriod;
			this.logger.warn({
				message: `Applying rate limit to AxiosRequestFactory`,
				request_factory_id: `${this._id}`,
				millis: millis + rateLimitSafetyPeriod
			});
		}


	}

	_waitForRateLimit() {

		if (this._rateLimitUntil) {
			const diff = this._rateLimitUntil - Date.now();
			if (diff > 0) {
				return new Promise((res, rej) => {
					setTimeout(() => {
						this._waitForRateLimit().then(res).catch(rej);
					}, diff);
				});
			}
		}

		return Promise.resolve();

	}

	async _trigger() {

		/** @type {import('axios').AxiosResponse} */
		let resp;
		let errored = false;
		let err;
		let next;
		let countAsAttemptOnFailure = true;

		// Wait for any rate limiting to finish
		await this._waitForRateLimit();

		// Check to see if we already have the maximum number of requests going on
		const [maxOngoingRequests] = await Promise.all([
			getValue(this._opts?.maxOngoingRequests)
		]);
		if (maxOngoingRequests != null && this._currentOngoingRequests >= maxOngoingRequests) {
			return;
		}

		// Check to see if there's actually another request to do (I know we checked before, but in case it changed after the awaits)
		next = this.getNextQueueItem();
		if (next == null) {
			return;
		}
		this._currentOngoingRequests += 1;

		// Create headers object if it doesn't exist and make a shorthand for it
		if (next.axiosConfig.headers == null) {
			next.axiosConfig.headers = {};
		}
		const headers = next.axiosConfig.headers;

		// Get any variables
		const [authHeader] = await Promise.all([
			headers['Authorization'] === undefined ? getValue(this._opts?.authHeader) : null, // Don't bother fetching the authHeader if we already have "Authorization" header set
		]);

		// Set the authorization header if we got one back
		if (authHeader) {
			headers['Authorization'] = authHeader;
		}

		// Execute callbacks
		await next.options?.beforeExec?.({
			axiosConfig: next.axiosConfig,
			resp: resp,
			previousAttempts: next.failedAttempts ?? 0,
		});

		await this._opts?.beforeExec?.({
			axiosConfig: next.axiosConfig,
			previousAttempts: next.failedAttempts ?? 0,
		});

		// Wait again for any rate limiting to finish because some might have been introduced since we checked before
		await this._waitForRateLimit();

		if (global.axios_request_factory_debug || this._opts?.debug) {
			console.log(`[ARF#${this._id}] Start: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
		}

		try {

			// Make the actual request
			resp = await this.axios(next.axiosConfig);

		} catch (e) {

			errored = true;
			resp = e?.response;
			err = e;

		}

		if (global.axios_request_factory_debug || this._opts?.debug) {
			if (errored) {
				console.error(`[ARF#${this._id}] Error: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
			} else {
				console.log(`[ARF#${this._id}]  Done: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
			}
		}

		// Execute callbacks
		await this._opts?.afterExec?.({
			errored: errored,
			error: err,
			axiosConfig: next.axiosConfig,
			resp: resp,
			previousAttempts: next.failedAttempts ?? 0,
		});

		await next.options?.afterExec?.({
			errored: errored,
			error: err,
			axiosConfig: next.axiosConfig,
			resp: resp,
			previousAttempts: next.failedAttempts ?? 0,
		});

		const reattemptOn = (await getValue(this._opts?.reattemptOn)) ?? ['NoStatusCode'];

		const statusForReattempt = resp?.status ?? 'NoStatusCode';

		try {

			// TODO: To add more handling here
			switch (resp?.status) {

				case 429: {
					this._updateRateLimit(resp);
					countAsAttemptOnFailure = false;
					break;
				}

			}

		} finally {

			try {

				// Assuming next is defined, we either need to add it back to the front of the queue it reject/resolve its promise
				if (next) {
					if (errored) {
						if (reattemptOn.includes(statusForReattempt)) {
							if (countAsAttemptOnFailure) {
								next.failedAttempts += 1;
							}
							const maxAttempts = (await getValue(this._opts?.maxAttempts)) ?? 1;
							if (next.failedAttempts >= maxAttempts) {
								next.rej(err);
							} else {
								this._specialRetryQueue.push(next);
							}
						} else {
							next.rej(err);
						}
					} else {
						next.res(resp);
					}
				}

			} catch (err) {

				this.logger.error({
					message: 'An error occurred when cleaning up the end of a AxiosRequestFactory request',
					req_factory_id: `${this._id}`,
					cause: err
				});

			} finally {

				// Start the loop again
				this._currentOngoingRequests -= 1;

				// For browsers where setImmediate isn't defined, use setTimeout with a low delay
				if (typeof setImmediate === 'undefined') {
					setTimeout(() => this.triggerNext(), 0);
				} else {
					setImmediate(() => this.triggerNext());
				}

			}

		}

	}

	triggerNext() {

		this._trigger().catch((err) => {
			this.logger.error({
				message: 'An error occurred during a AxiosRequestFactory trigger',
				req_factory_id: `${this._id}`,
				cause: err
			});
		});

	}

}

const randomString = (length) => {
    let output = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    while (output.length < length) {
		output += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return output;
}

const usedIds = [];

const createId = (axiosInstanceOpts) => {

	const urlString = axiosInstanceOpts?.url ?? axiosInstanceOpts?.baseURL;

	if (urlString) {
		const url = new URL(urlString);
		if (url.hostname) {
			return url.hostname;
		}
	}

	return randomString(16);

}

const createUniqueId = (id, axiosInstanceOpts) => {

	const rawId = id ?? createId(axiosInstanceOpts);

	const stringId = `${rawId}`.replace(/#/g, '_');

	if (!usedIds.includes(stringId)) {
		usedIds.push(stringId);
		return stringId;
	}

	let number = 0;
	while (true) {
		if (++number > 1000) {
			throw new Error(`Infinite loop detected setting ID`);
		}
		const test = `${stringId}#${number}`;
		if (!usedIds.includes(test)) {
			usedIds.push(test);
			return test;
		}
	}

}

module.exports.AxiosRequestFactory = AxiosRequestFactory;
