
import { AxiosRequestConfig, AxiosResponse } from 'axios';

type Functionisable<T> = T|(() => T|Promise<T>);

interface AxiosRequestFactoryConstructorOptions {
	id?: string;
	axiosInstanceOptions: AxiosRequestConfig;
	logger?: any;
	authHeader?: Functionisable<string>
	maxAttempts?: Functionisable<number>;
	rateLimitSafetyPeriod?: number;
	maxOngoingRequests?: Functionisable<number>;
	debug?: boolean;
	reattemptOn?: Functionisable<(number|'NoStatusCode')[]>;
	beforeExec?: ({axiosConfig: AxiosRequestConfig, previousAttempts: number}) => void|Promise<void>;
	afterExec?: ({errored: boolean, error: any, axiosConfig: AxiosRequestConfig, resp: AxiosResponse, previousAttempts: number}) => void|Promise<void>;
}

interface AxiosRequestFactoryRequestOptions {
	priority?: number;
	beforeExec?: ({axiosConfig: AxiosRequestConfig, previousAttempts: number}) => void|Promise<void>;
	afterExec?: ({errored: boolean, error: any, axiosConfig: AxiosRequestConfig, resp: AxiosResponse, previousAttempts: number}) => void|Promise<void>;
}

export class AxiosRequestFactory {

	constructor(options?: AxiosRequestFactoryConstructorOptions)

	request(axiosConfig: AxiosRequestConfig, options?: AxiosRequestFactoryRequestOptions): Promise<AxiosResponse>

}
