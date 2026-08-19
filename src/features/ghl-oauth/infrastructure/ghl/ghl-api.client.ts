import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import type { GhlTokenRefreshUseCase } from "@/features/ghl-oauth/application/use-cases/ghl-token-refresh.use-case";

export class GhlApiClient {
  constructor(private readonly tokenRefresh: GhlTokenRefreshUseCase) {}

  async request<T>(tenantId: string, config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const accessToken = await this.tokenRefresh.getValidAccessToken(tenantId);
    try {
      return await this.send<T>(config, accessToken);
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error;
      const refreshedAccessToken = await this.tokenRefresh.forceRefresh(tenantId);
      return this.send<T>(config, refreshedAccessToken);
    }
  }

  private send<T>(config: AxiosRequestConfig, accessToken: string): Promise<AxiosResponse<T>> {
    return axios.request<T>({
      ...config,
      headers: {
        ...config.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }
}
