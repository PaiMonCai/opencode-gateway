/**
 * Express type augmentation for the properties the gateway's HTTP edge adds to
 * every request. Kept next to the middleware that sets them.
 *
 * The shapes mirror `src/http/request-context.js`.
 */

/** Request-scoped context attached by the request-context middleware. */
interface GatewayRequestContext {
    id: string;
    startedAt: number;
    signal: AbortSignal;
    abortedBy: 'client' | null;
    logger: unknown;
}

declare global {
    namespace Express {
        interface Request {
            /** Request id (client-supplied when valid, else generated). */
            id?: string;
            /** Alias of {@link Request.id}, for callers that prefer the explicit name. */
            requestId?: string;
            /** Aborted when the client disconnects. */
            abortSignal?: AbortSignal;
            /** Full request context set by the request-context middleware. */
            context?: GatewayRequestContext;
        }
    }
}

export {};
