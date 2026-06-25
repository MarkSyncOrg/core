import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../types/api.js';

/**
 * Creates a fully typed xBrowserSync API client bound to a given service URL.
 *
 * Types are generated from the OpenAPI contract (`openapi/xbrowsersync-api.yaml`)
 * via `npm run gen:api`, so the client surface always tracks the backend contract.
 *
 * @param baseUrl Base URL of the xBrowserSync service (no trailing slash required).
 */
export function createApiClient(baseUrl: string): Client<paths> {
  return createClient<paths>({ baseUrl });
}
