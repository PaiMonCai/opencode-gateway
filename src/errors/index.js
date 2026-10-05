/**
 * Public surface of the error module.
 *
 * @module errors
 */

export {
    ERROR_CODES,
    ERROR_STATUS_CODES,
    ERROR_TYPES,
    GatewayError,
    isGatewayError,
    InvalidRequestError,
    AuthenticationError,
    PermissionDeniedError,
    ModelNotFoundError,
    InsufficientQuotaError,
    RateLimitError,
    TimeoutError,
    ConversationBusyError,
    SessionStateUnavailableError,
    InternalError
} from './taxonomy.js';

export {
    toOpenAIError,
    asGatewayError,
    codeForStatus,
    isTransientUpstreamError,
    transformUpstreamError
} from './mapping.js';
