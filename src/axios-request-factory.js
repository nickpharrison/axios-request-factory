
const axios = require('axios').default;
let fs;
let path;
let stream;
if (typeof window === 'undefined') {
	try {
		fs = require('fs');
	} catch (err) {
	}
	try {
		path = require('path');
	} catch (err) {
	}
	try {
		stream = require('stream');
	} catch (err) {
	}
}

const parseAuthHeader = (auth) => {
	if (typeof auth === 'string') {
		return auth;
	}
	if (auth.username != null && auth.password != null) {
		return `Basic ${Buffer.from(auth.username + ':' + auth.password, 'utf-8').toString('base64')}`;
	}
	if (auth.bearer != null) {
		return `Bearer ${auth.bearer}`;
	}
	throw new Error(`Could not parse auth header`);
}

const getValue = async (input) => {
	if (typeof input === 'function') {
		return await input();
	}
	return input;
}

const ALLOWED_METHODS = typeof process !== 'undefined' && process.env.ARF_ALLOWED_METHODS ? process.env.ARF_ALLOWED_METHODS.split(',').map(x => x.trim().toUpperCase()) : null;

class CacheRewriteArfError extends Error {

	constructor(status, headers, data, code, message) {
		super(message);
		this.response = {
			status,
			headers,
			data,
		}
		this.code = code;
	}

}

class CancellationArfError extends Error {
	constructor() {
		super(`Cancelled`);
	}
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

		// Custom rate limiting properties
		this._customRateLimit = this._opts?.customRateLimit;
		this._requestTimestamps = [];
		this._lastCleanup = Date.now();

		this.axios = axios.create(this._opts?.axiosInstanceOptions);

		this._id = createUniqueId(this._opts?.id, this._opts?.axiosInstanceOptions);

	}

	addQueueItemToQueue(obj) {

		if (obj.priority === undefined || typeof obj.priority === 'number') {
			// pass
		} else {
			throw new Error(`Priority ${obj.priority} is not valid for request factory. Must be a number if specified`);
		}

		this.readFromCache(obj).then((result) => {
			if (result) {
				obj.res(result);
			} else {
				this._queue.push(obj);
				this.triggerNext();	
			}
		}).catch((err) => {
			obj.rej(err);
		});

	}

	getNextQueueItem() {
		this.removeCancelledFromQueue();
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

	removeCancelledFromQueue() {
		const checkQueue = (queue) => {
			for (let i = 0; i < queue.length; i += 1) {
				if (queue[i].options.cancellationToken?.isCancelled) {
					const removed = queue.splice(i, 1)[0];
					removed.rej(new CancellationArfError());
					i -= 1;
				}
			}
		};
		checkQueue(this._queue);
		checkQueue(this._specialRetryQueue);
	}

	/**
	 * 
	 * @param {import('axios').AxiosRequestConfig} axiosConfig 
	 * @param {{priority: number}} options Priority 9 is high priority and priority 1 is low priority
	 * @returns {Promise<import('axios').AxiosResponse>} 
	 */
	request(axiosConfig, options) {

		let cancellationFunction;

		return new Promise((res, rej) => {

			if (axiosConfig == null) {
				rej(new Error('Cannot call a factory request with no axiosConfig'));
				return;
			}

			if (options == null) {
				options = {};
			}

			const obj = {res, rej, axiosConfig, options, failedAttempts: 0};

			if (options.cancellationToken?.isCancelled) {
				return rej(new CancellationArfError());
			}

			if (typeof options.cancellationToken?.on === 'function') {
				cancellationFunction = () => {
					this.removeCancelledFromQueue();
				};
				options.cancellationToken.on('cancel', cancellationFunction);
			}

			try {
				this.addQueueItemToQueue(obj);
			} catch (err) {
				rej(err);
			}

		}).finally(() => {
			if (cancellationFunction) {
				options.cancellationToken.off('cancel', cancellationFunction);
			}
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

	_cleanupOldTimestamps() {
		if (!this._customRateLimit || this._customRateLimit?.disabled || !this._customRateLimit?.perPeriodMs) {
			return;
		}

		const now = Date.now();
		// Cleanup every 10 seconds to prevent excessive cleanup operations
		if (now - this._lastCleanup < 10000) {
			return;
		}

		const cutoff = now - this._customRateLimit.perPeriodMs;
		this._requestTimestamps = this._requestTimestamps.filter(timestamp => timestamp > cutoff);
		this._lastCleanup = now;
	}

	async _waitForCustomRateLimit() {
		if (!this._customRateLimit || this._customRateLimit?.disabled) {
			return;
		}

		const { maxRequests, perPeriodMs } = this._customRateLimit;
		if (!maxRequests || !perPeriodMs) {
			return;
		}

		// Cleanup old timestamps periodically
		this._cleanupOldTimestamps();

		const now = Date.now();
		const cutoff = now - perPeriodMs;
		
		// Count requests within the time window
		const recentRequests = this._requestTimestamps.filter(timestamp => timestamp > cutoff);
		
		if (recentRequests.length < maxRequests) {
			return;
		}

		// Calculate when the oldest request in the window will expire
		const oldestInWindow = recentRequests[0];
		const waitTime = oldestInWindow + perPeriodMs - now;

		if (waitTime <= 0) {
			return;
		}

		return new Promise((res, rej) => {
			setTimeout(() => {
				this._waitForCustomRateLimit().then(res).catch(rej);
			}, waitTime);
		});
	}

	async _trigger() {

		/** @type {import('axios').AxiosResponse} */
		let resp;
		let errored = false;
		let err;
		let next;
		let mockResponse;
		let countAsAttemptOnFailure = true;
		let reattemptOn;
		let statusForReattempt;

		try {

			// Wait for custom rate limiting first (proactive)
			await this._waitForCustomRateLimit();

			// Wait for any rate limiting to finish (reactive)
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

			if (next.options?.cancellationToken?.isCancelled) {
				throw new CancellationArfError();
			}

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
				headers['Authorization'] = parseAuthHeader(authHeader);
			}

			if (next.options?.cancellationToken?.isCancelled) {
				throw new CancellationArfError();
			}

			if (next.axiosConfig.method == null) {
				next.axiosConfig.method = 'GET';
			}

			const allowedMethods = next.options.allowedMethods ?? this._opts.allowedMethods ?? ALLOWED_METHODS;
			if (allowedMethods && !allowedMethods.map(x => x.toUpperCase()).includes(next.axiosConfig.method.toUpperCase())) {
				throw new Error(`Tried to conduct a "${next.axiosConfig.method.toUpperCase()}" request to "${next.axiosConfig.url}", but this is not one of the allowed methods: ${allowedMethods.join(', ')}`);
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
			await this._waitForCustomRateLimit();
			await this._waitForRateLimit();

			if (globalThis.axios_request_factory_debug || this._opts?.debug) {
				console.log(`[ARF#${this._id}] Start: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
			}

			// Get mock response
			if (process.env.ARF_USE_MOCK_RESPONSES?.toLowerCase() === 'true') {
				mockResponse = (await getValue(next.options?.mockResponse)) ?? (await getValue(this._opts?.mockResponse));
			}

			if (mockResponse == null) {

				// Make the actual request
				resp = await this.axios(next.axiosConfig);

				// Track successful request timestamp for custom rate limiting
				if (this._customRateLimit && !this._customRateLimit?.disabled) {
					this._requestTimestamps.push(Date.now());
				}

			} else {

				resp = mockResponse;

			}

		} catch (e) {

			errored = true;
			resp = e?.response;
			err = e;

		}

		try {

			if (globalThis.axios_request_factory_debug || this._opts?.debug) {
				if (errored) {
					console.error(`[ARF#${this._id}] Error: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
				} else {
					console.log(`[ARF#${this._id}]  Done: ${next.axiosConfig.method ?? 'GET'} ${next.axiosConfig.baseURL ?? ''}${next.axiosConfig.url}`);
				}
			}
	
			// Execute callbacks if there is actually a response (don't bother for some otehr kind of error (like runtime error))
			if (!errored || resp) {
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
			}
	
			reattemptOn = (await getValue(this._opts?.reattemptOn)) ?? ['NoStatusCode'];
			statusForReattempt = resp?.status ?? 'NoStatusCode';

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

				const getWaitForCacheWriteBeforeReturning = async () => (await getValue(next.options?.waitForCacheWriteBeforeReturning)) ?? (await getValue(this._opts?.waitForCacheWriteBeforeReturning));

				const handleError = () => {
					if (mockResponse != null) {
						return next.rej(err);
					}
					const cacheRewriteErrorCode = next.options?.cacheRewriteErrorCode?.(err);
					if (cacheRewriteErrorCode == null) {
						return next.rej(err);
					}
					const newErr = new CacheRewriteArfError(resp.status, resp.headers, resp.data, cacheRewriteErrorCode, err.message);
					newErr.cacheWritePromise = this.writeToCache(resp, next, newErr);
					if (newErr.cacheWritePromise) {
						getWaitForCacheWriteBeforeReturning().then((wait) => {
							if (wait) {
								newErr.cacheWritePromise.finally(() => {
									next.rej(newErr);
								});
							} else {
								next.rej(newErr);
							}
						})
					} else {
						next.rej(newErr);
					}
				}
	
				const handleSuccess = () => {
					if (mockResponse != null) {
						return next.res(resp);
					}
					resp.cacheWritePromise = this.writeToCache(resp, next, null);
					if (resp.cacheWritePromise) {
						getWaitForCacheWriteBeforeReturning().then((wait) => {
							if (wait) {
								resp.cacheWritePromise.finally(() => {
									next.res(resp);
								});
							} else {
								next.res(resp);
							}
						});
					} else {
						next.res(resp);
					}
				}
	
				// Assuming next is defined, we either need to add it back to the front of the queue it reject/resolve its promise
				if (next) {
					if (errored) {
						if (err instanceof CancellationArfError) {
							// do nothing
						} else if (reattemptOn.includes(statusForReattempt)) {
							if (countAsAttemptOnFailure) {
								next.failedAttempts += 1;
							}
							const maxAttempts = (await getValue(this._opts?.maxAttempts)) ?? 1;
							if (next.failedAttempts >= maxAttempts) {
								handleError();
							} else {
								this._specialRetryQueue.push(next);
							}
						} else {
							handleError();
						}
					} else {
						handleSuccess();
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

	async readFromCache(next) {

		const cachePath = next.options?.cachePath;
		const cacheKey = next.options?.cacheKey;
		if (!fs || !cachePath || !cacheKey) {
			return undefined;
		}

		const { filePath } = getCachingFilePath(cachePath, cacheKey);

		const result = await fs.promises.readFile(filePath, 'utf-8').catch((err) => {
			if (err?.code === 'ENOENT') {
				return undefined
			}
			throw err;
		});

		if (result == null) {
			return undefined;
		}

		const resp = JSON.parse(result);

		if (resp.error && !next.options.cacheIgnoreErrors) {
			throw new CacheRewriteArfError(resp.status, resp.headers, resp.error.data, resp.error.code, resp.error.message);
		}

		const specifiedEncoding = resp._arfDataEncoding

		if (next.axiosConfig?.responseType === 'stream') {

			resp.data = fs.createReadStream(resp._arfDataPath, {encoding: specifiedEncoding});

		} else {

			let data = await fs.promises.readFile(resp._arfDataPath, {encoding: specifiedEncoding});

			if (resp._arfDataType === 'object') {
				data = JSON.parse(data);
			}

			resp.data = data;

		}

		return resp;

	}

	/**
	 * 
	 * @param {any} resp 
	 * @param {any} next 
	 * @param {CacheRewriteArfError} err 
	 * @returns {undefined|Promise<{written: boolean}>} This function purposefully don't always return a promise! If we're not caching then we want resp.cacheWritePromise to be undefined, not an instantly resolved promise
	 */
	writeToCache(resp, next, err) {

		const cachePath = next.options?.cachePath;
		const cacheKey = next.options?.cacheKey;
		if (!fs || !cachePath || !cacheKey) {
			return undefined;
		}

		let writeStream;
		let passthroughStream;

		const { filePath, dataPath, folderPath } = getCachingFilePath(cachePath, cacheKey);

		let written = false;

		return Promise.resolve().then(async () => {

			const data = resp.data;

			const cacheObj = {
				status: resp.status,
				headers: resp.headers,
				_arfFilePath: filePath,
			}

			if (err) {
				cacheObj.error = {
					code: err.code,
					message: err.message,
					data: typeof data.pipe === 'function' ? null : err.data,
				};
			} else {
				cacheObj._arfDataPath = dataPath;
			}

			let contentToWrite;

			////// IMPORTANT NOTE ABOUT THE STREAMING CASE ////////
			// Do not put any "async/await" operations before we start the streaming, otherwise if the consumer attaches a listener straight away then we usually don't get to attach the listeners before the streaming starts. This is why we have this weird situation where we push data into a passthrough and then pipe the passthrough to the writestream AFTER the directory has been made

			if (cacheObj.error) {
				//do nothing
			} else if (typeof data.pipe === 'function' && typeof data.once === 'function') {
				cacheObj._arfDataType = 'stream';
				cacheObj._arfDataEncoding = data.readableEncoding;
				passthroughStream = new stream.PassThrough();
				data.once('data', (firstChunk) => {
					passthroughStream.write(firstChunk);
					data.on('data', (chunk) => {
						passthroughStream.write(chunk);
					});
				});
				data.on('end', () => {
					passthroughStream.end();
				});
				data.on('error', (err) => {
					passthroughStream.emit('error', err);
				});
			} else if (data instanceof Buffer) {
				cacheObj._arfDataType = 'buffer';
				cacheObj._arfDataEncoding = undefined;
				contentToWrite = data;
			} else if (typeof data === 'string') {
				cacheObj._arfDataType = 'string';
				cacheObj._arfDataEncoding = 'utf-8';
				contentToWrite = data
			} else if (typeof data === 'object') {
				cacheObj._arfDataType = 'object';
				cacheObj._arfDataEncoding = 'utf-8';
				contentToWrite = JSON.stringify(data);
			} else {
				throw new Error(`Could not determine how to cache response of type ${typeof data}`);
			}

			await fs.promises.mkdir(folderPath, {recursive: true});

			if (passthroughStream) {
				writeStream = fs.createWriteStream(dataPath, {encoding: data.readableEncoding});
				passthroughStream.pipe(writeStream);
				await new Promise((res, rej) => {
					writeStream.on('error', (err) => {
						rej(err);
					});
					writeStream.on('close', () => {
						res();
					});
				});
			}
			if (contentToWrite) {
				await fs.promises.writeFile(dataPath, contentToWrite, cacheObj._arfDataEncoding);
			}

			// Make sure to write this one AFTER the main data file so that we don't signal that the request is cached before the data is written (we should NOT write both files at the same time because the main file will likely finish first)
			await fs.promises.writeFile(filePath, JSON.stringify(cacheObj), 'utf-8');

			written = true;

		}).catch((err) => {
			this.logger.error({
				message: 'Error handling caching',
				req_factory_id: `${this._id}`,
				cause: err
			});
			const promises = [fs.promises.rm(filePath, {force: true})];
			if (writeStream) {
				promises.push(
					new Promise((res, rej) => writeStream.close((err) => err ? rej(err) : res())).then(() => fs.promises.rm(dataPath, {force: true}))
				);
			}
			if (passthroughStream) {
				promises.push(
					new Promise((res, rej) => passthroughStream.close((err) => err ? rej(err) : res()))
				);
			}
			return Promise.all(promises);
		}).catch((err) => {
			this.logger.error({
				message: 'Error clearing-up data after caching error',
				req_factory_id: `${this._id}`,
				cause: err
			});
		}).then(() => {
			return {
				written
			};
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

const getCachingFilePath = (cachePath, url) => {

	const encoded = encodeURIComponent(url).replace(/\*/g, '%2A');

	const folderPath = path.resolve(cachePath);

	const dataPath = path.join(folderPath, encoded);	

	return {
		folderPath,
		filePath: dataPath + '.json',
		dataPath,
	};

}

module.exports.AxiosRequestFactory = AxiosRequestFactory;
