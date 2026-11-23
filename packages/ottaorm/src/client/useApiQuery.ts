// ============================================================
// @ottabase/ottaorm/client - Generic API Query Hooks
// ============================================================
// Custom endpoint hooks that share OttaORM cache namespaces
// ============================================================

import {
    useMutation,
    useQuery,
    useQueryClient,
    type QueryKey,
    type UseMutationOptions,
    type UseQueryOptions,
} from '@tanstack/react-query';
import {
    getStableQuerySignal,
    queryRetryDelay,
    shouldAutoRefetchQuery,
    shouldRetryQuery,
    useApiClient,
} from './QueryProvider';
import { endpointUrl, type Endpoint, type EndpointCall, type EndpointOutput } from '@ottabase/utils/endpoint';
import type { ApiClientError, ApiClientRequestOptions } from './types';

export interface ApiQueryOptions<TData, TSelected = TData> {
    /** Entity name used as an invalidation namespace. */
    entity?: string;
    queryKey: QueryKey;
    endpoint: string;
    /** Additional GET options. Method, body, and signal remain framework-owned. */
    requestOptions?: Omit<ApiClientRequestOptions, 'method' | 'body' | 'signal'>;
    /** Observer-local projection. Transformed data is never written into the shared cache. */
    select?: (data: TData) => TSelected;
    queryOptions?: Omit<
        UseQueryOptions<TData, ApiClientError, TSelected>,
        | 'queryKey'
        | 'queryFn'
        | 'select'
        | 'retry'
        | 'retryDelay'
        | 'refetchOnMount'
        | 'refetchOnWindowFocus'
        | 'refetchOnReconnect'
    >;
}

/**
 * Fetch a custom GET endpoint through the mandatory framework client.
 */
export function useApiQuery<TData, TSelected = TData>(options: ApiQueryOptions<TData, TSelected>) {
    const { entity, queryKey, endpoint, requestOptions, select, queryOptions } = options;
    const apiClient = useApiClient();
    const resolvedKey: QueryKey = entity ? [entity, ...queryKey] : queryKey;

    return useQuery<TData, ApiClientError, TSelected>({
        ...queryOptions,
        queryKey: resolvedKey,
        queryFn: async (context) =>
            apiClient<TData>(endpoint, {
                ...requestOptions,
                method: 'GET',
                signal: await getStableQuerySignal(context),
            }),
        select,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        refetchOnMount: shouldAutoRefetchQuery,
        refetchOnWindowFocus: shouldAutoRefetchQuery,
        refetchOnReconnect: shouldAutoRefetchQuery,
    });
}

export interface ApiMutationOptions<TData, TVariables, TContext = unknown> {
    endpoint: string | ((variables: TVariables) => string);
    method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Entity namespaces invalidated after a successful mutation. */
    invalidateEntities?: string[];
    /** Exact or prefix query keys invalidated after a successful mutation. */
    invalidateKeys?: QueryKey[];
    /** Additional request options. Method and body remain framework-owned. */
    requestOptions?: Omit<ApiClientRequestOptions, 'method' | 'body'>;
    /** The request body for these variables. Default: the variables themselves (none for DELETE). */
    body?: (variables: TVariables) => unknown;
    mutationOptions?: Omit<
        UseMutationOptions<TData, ApiClientError, TVariables, TContext>,
        'mutationFn' | 'retry' | 'retryDelay'
    >;
}

/**
 * Execute a custom mutation without implicit retries or write deduplication.
 * Internal invalidation is composed with, and cannot be replaced by, consumer
 * lifecycle callbacks.
 */
export function useApiMutation<TData, TVariables = unknown, TContext = unknown>(
    options: ApiMutationOptions<TData, TVariables, TContext>,
) {
    const {
        endpoint,
        method = 'POST',
        invalidateEntities = [],
        invalidateKeys = [],
        requestOptions,
        body,
        mutationOptions,
    } = options;
    const queryClient = useQueryClient();
    const apiClient = useApiClient();
    const { onSuccess: consumerOnSuccess, ...consumerOptions } = mutationOptions ?? {};

    return useMutation<TData, ApiClientError, TVariables, TContext>({
        ...consumerOptions,
        retry: false,
        mutationFn: async (variables): Promise<TData> => {
            const url = typeof endpoint === 'function' ? endpoint(variables) : endpoint;
            return apiClient<TData>(url, {
                ...requestOptions,
                method,
                body: body ? body(variables) : method === 'DELETE' ? undefined : variables,
            });
        },
        onSuccess: async (data, variables, onMutateResult, mutationContext) => {
            // A caller may navigate to a dependent screen in its onSuccess.
            // Wait until every matching query has been marked stale/refetched
            // before reporting the mutation as complete.
            await Promise.all([
                ...invalidateEntities.map((entity) => queryClient.invalidateQueries({ queryKey: [entity] })),
                ...invalidateKeys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
            ]);
            await consumerOnSuccess?.(data, variables, onMutateResult, mutationContext);
        },
    });
}

export interface BatchMutationOptions<TData, TVariables extends unknown[], TContext = unknown> extends Omit<
    ApiMutationOptions<TData, TVariables, TContext>,
    'method'
> {
    method?: 'POST' | 'DELETE';
}

export function useBatchMutation<TData, TVariables extends unknown[], TContext = unknown>(
    options: BatchMutationOptions<TData, TVariables, TContext>,
) {
    return useApiMutation<TData, TVariables, TContext>(options);
}

// ── Typed endpoints (@ottabase/utils/endpoint) ──

/**
 * Read a GET endpoint declared with `defineEndpoint`: the URL is built from the typed params, the
 * input goes in the query string, and the data is typed by the declaration. Everything else is
 * `useApiQuery` (cache scope, retries, cancellation).
 */
export function useEndpointQuery<E extends Endpoint<string, unknown, unknown>, TSelected = EndpointOutput<E>>(
    endpoint: E,
    call: EndpointCall<E>,
    options: Omit<ApiQueryOptions<EndpointOutput<E>, TSelected>, 'endpoint'>,
) {
    if (endpoint.method !== 'GET') {
        throw new Error(
            `[useEndpointQuery] ${endpoint.method} ${endpoint.path} is not a GET endpoint; use useEndpointMutation`,
        );
    }
    const input = (call as { input?: Record<string, string | number | boolean | null | undefined> }).input;
    return useApiQuery<EndpointOutput<E>, TSelected>({
        ...options,
        endpoint: endpointUrl(endpoint, (call as { params?: Record<string, string> }).params),
        requestOptions: input
            ? { ...options.requestOptions, params: { ...options.requestOptions?.params, ...input } }
            : options.requestOptions,
    });
}

/**
 * Write through an endpoint declared with `defineEndpoint`. The mutation's variables are the
 * call (`{ params, input }`): the params fill the path, the input is the body, and the result is
 * typed by the declaration. Everything else is `useApiMutation` (no retries, invalidation).
 */
export function useEndpointMutation<E extends Endpoint<string, unknown, unknown>, TContext = unknown>(
    endpoint: E,
    options: Omit<
        ApiMutationOptions<EndpointOutput<E>, EndpointCall<E>, TContext>,
        'endpoint' | 'method' | 'body'
    > = {},
) {
    if (endpoint.method === 'GET') {
        throw new Error(`[useEndpointMutation] ${endpoint.path} is a GET endpoint; use useEndpointQuery`);
    }
    return useApiMutation<EndpointOutput<E>, EndpointCall<E>, TContext>({
        ...options,
        method: endpoint.method,
        endpoint: (call) => endpointUrl(endpoint, (call as { params?: Record<string, string> }).params),
        body: (call) => (call as { input?: unknown }).input,
    });
}
