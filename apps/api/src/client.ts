import { hc } from "hono/client";
import type { ApiType } from "./app";

/** Typed Hono RPC client for the API, shared by the SPA and the tests. */
export const createApiClient = (...args: Parameters<typeof hc>) => hc<ApiType>(...args);
export type ApiClient = ReturnType<typeof createApiClient>;
