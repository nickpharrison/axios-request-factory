
import { AxiosRequestConfig, AxiosResponse } from 'axios';

interface AxiosRequestFactoryRequestOptions {
	id?: string;
	axiosInstanceOptions: AxiosRequestConfig;
	logger?: any;
}

interface AxiosRequestFactoryConstructorOptions {
	priority?: number;
}

export class AxiosRequestFactory {

	constructor(options?: AxiosRequestFactoryConstructorOptions)

	request(axiosConfig: AxiosRequestConfig, options?: AxiosRequestFactoryOptions): Promise<AxiosResponse>

}
