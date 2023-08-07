
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

		/** @type {{res: (value: any) => void, rej: (reason: any) => void, axiosConfig: import('axios').AxiosRequestConfig, options: any, failedAttempts: number}[][]} */
		this._queues = [];
		for (let i = 0; i < 10; i += 1) {
			this._queues.push([]);
		}
		/** @type {{res: (value: any) => void, rej: (reason: any) => void, axiosConfig: import('axios').AxiosRequestConfig, options: any, failedAttempts: number}[]} */
		this._specialRetryQueue = [];

		this._currentOngoingRequests = 0;

		this.axios = axios.create(this._opts?.axiosInstanceOptions);

	}

	addQueueItemToQueue(obj) {

		const priority = obj.priority;

		const queue = this._queues[priority];

		if (queue === undefined) {
			rej(new Error(`Priority ${priority} is not valid for request factory. Must be an integer between 0 and ${this._queues.length - 1}`));
			return;
		}

		queue.push(obj);

	}

	getNextQueueItem() {
		if (this._specialRetryQueue.length !== 0) {
			return this._specialRetryQueue.shift();
		}
		for (let i = this._queues.length - 1; i >= 0; i -= 1) {
			const queue = this._queues[i];
			if (queue.length !== 0) {
				return queue.shift();
			}
		}
		return undefined;
	}

	/**
	 * 
	 * @param {import('axios').AxiosRequestConfig} axiosConfig 
	 * @param {{doPriority: boolean, priority: number}} options Priority 9 is high priority and priority 1 is low priority
	 * @returns {Promise<import('axios').AxiosResponse>} 
	 */
	request(axiosConfig, options) {

		return new Promise((res, rej) => {

			if (axiosConfig == null) {
				rej(new Error('Cannot call a factory request with no axiosConfig'));
				return;
			}

			// do Priority is for backward compatibility
			const priority = (options?.doPriority ? 9 : options?.priority) ?? 5;

			const obj = {res, rej, axiosConfig, options, priority, failedAttempts: 0};

			this.addQueueItemToQueue(obj);

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
				request_factory_id: `${this._opts.id}`,
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
		let allowReattemptIfFail = true;
		let countAsAttemptOnFailure = true;

		try {

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

			// Wait again for any rate limiting to finish because some might have been introduced since we checked before
			await this._waitForRateLimit();

			// Make the actual request
			resp = await this.axios(next.axiosConfig);

		} catch (e) {

			errored = true;
			resp = e?.response;
			err = e;

		}

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
						if (allowReattemptIfFail) {
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
					req_factory_id: `${this._opts.id}`,
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
				req_factory_id: `${this._opts.id}`,
				cause: err
			});
		});

	}

}

module.exports.AxiosRequestFactory = AxiosRequestFactory;
