
import { AxiosRequestConfig, AxiosResponse } from 'axios';

type AxiosRequestFactoryRequestOptions = {
	id?: string;
	axiosInstanceOptions: AxiosRequestConfig;
	logger?: any;
}

type AxiosRequestFactoryConstructorOptions = {
	priority?: number;
}

export class AxiosRequestFactory {

	constructor(options?: AxiosRequestFactoryConstructorOptions)

	request(axiosConfig: AxiosRequestConfig, options?: AxiosRequestFactoryOptions): Promise<AxiosResponse>

}
