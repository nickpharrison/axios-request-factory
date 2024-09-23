
import { AxiosRequestConfig, AxiosResponse } from 'axios';

interface AxiosRequestFactoryConstructorOptions {
	id?: string;
	axiosInstanceOptions: AxiosRequestConfig;
	logger?: any;
}

interface AxiosRequestFactoryRequestOptions {
	priority?: number;
}

export class AxiosRequestFactory {

	constructor(options?: AxiosRequestFactoryConstructorOptions)

	request(axiosConfig: AxiosRequestConfig, options?: AxiosRequestFactoryRequestOptions): Promise<AxiosResponse>

}
