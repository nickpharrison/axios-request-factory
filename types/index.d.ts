
import { AxiosRequestConfig, AxiosResponse } from 'axios';

type AxiosRequestFactoryRequestOptions = {
	axiosInstanceOptions: AxiosRequestConfig;
}

type AxiosRequestFactoryConstructorOptions = {
	priority: number;
}

export class AxiosRequestFactory {

	constructor(options: AxiosRequestFactoryConstructorOptions)

	request(axiosConfig: AxiosRequestConfig, options: AxiosRequestFactoryOptions): Promise<AxiosResponse>

}
