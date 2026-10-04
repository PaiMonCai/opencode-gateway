import {
    DEFAULT_CONVERSATION_HEADER_NAMES,
    conversationKeyFor,
    conversationScopeFor,
    deriveIdentity,
    derivedScopeFor,
    matchDerivedEntry,
    normalizeHeaderNames,
    normalizeHeaders,
    readHeaderIdentity
} from '../../../src/conversation/identity.js';
import { prefixDigest, replyDigestFor } from '../../../src/conversation/planner.js';

/** Build a stored entry as the store would. */
const entry = (overrides = {}) => ({
    sessionId: 'session-1',
    mode: 'runtime',
    sentCount: 0,
    sentDigest: null,
    replyDigest: null,
    startKey: null,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides
});

describe('conversation identity headers', () => {
    test('accepts every documented header spelling', () => {
        expect(DEFAULT_CONVERSATION_HEADER_NAMES).toHaveLength(11);
        for (const name of DEFAULT_CONVERSATION_HEADER_NAMES) {
            const identity = readHeaderIdentity({ headers: { [name]: 'conv-1' } });
            expect(identity).not.toBeNull();
            expect(identity.source).toEqual('header');
            expect(identity.header).toEqual(name);
            expect(identity.value).toEqual('conv-1');
        }
    });

    test('takes the first non-empty value in the configured order', () => {
        const identity = readHeaderIdentity({
            headers: {
                'session-id': '   ',
                'thread-id': 'from-thread',
                'x-opencode-session': 'from-opencode'
            }
        });
        expect(identity.header).toEqual('x-opencode-session');
        expect(identity.value).toEqual('from-opencode');
    });

    test('follows the published precedence, x-opencode-session first', () => {
        // The operator configures the identity on the gateway side
        // (x-opencode-session); a client-supplied session-id must not displace
        // it. `x-opencode-session` leads the published list, and
        // SESSION_HEADER_NAMES can narrow or reorder it.
        const identity = readHeaderIdentity({
            headers: { 'session-id': 'plain', 'x-opencode-session': 'opencode' }
        });
        expect(identity.header).toEqual('x-opencode-session');
        expect(identity.value).toEqual('opencode');
        const narrowed = readHeaderIdentity({
            headers: { 'session-id': 'plain', 'x-opencode-session': 'opencode' },
            headerNames: ['x-session-id', 'session-id']
        });
        expect(narrowed.value).toEqual('plain');
    });

    test('prefers the operator-configured header over the client one', () => {
        // A gateway that overrides the session id for every request (NewAPI style)
        // uses x-opencode-session; the client's own session-id is ignored.
        const identity = readHeaderIdentity({
            headers: {
                'session-id': 'client-thread',
                'x-deepseek-harness-session-id': 'client-harness',
                'x-opencode-session': 'operator-identity'
            }
        });
        expect(identity.header).toEqual('x-opencode-session');
        expect(identity.value).toEqual('operator-identity');
    });

    test('trims the value, keeps it whole, and only clips the preview', () => {
        const longValue = 'x'.repeat(200);
        const identity = readHeaderIdentity({ headers: { 'session-id': `  ${longValue}  ` } });
        expect(identity.value).toEqual(longValue);
        expect(identity.preview).toHaveLength(64);
    });

    test('repeated headers use their first value', () => {
        const identity = readHeaderIdentity({ headers: { 'session-id': ['first', 'second'] } });
        expect(identity.value).toEqual('first');
    });

    test('is ignored when reuse is disabled', () => {
        expect(readHeaderIdentity({ headers: { 'session-id': 'conv' }, enabled: false })).toBeNull();
    });

    test('narrows the list from a comma-separated config value', () => {
        const headerNames = normalizeHeaderNames('X-My-Session, x-other ,,');
        expect(headerNames).toEqual(['x-my-session', 'x-other']);
        const identity = readHeaderIdentity({
            headers: { 'session-id': 'ignored', 'x-my-session': 'kept' },
            headerNames
        });
        expect(identity.header).toEqual('x-my-session');
        expect(readHeaderIdentity({ headers: { 'session-id': 'ignored' }, headerNames })).toBeNull();
    });

    test('falls back to the default list when the configured one is empty', () => {
        expect(normalizeHeaderNames([])).toEqual([...DEFAULT_CONVERSATION_HEADER_NAMES]);
        expect(normalizeHeaderNames(null)).toEqual([...DEFAULT_CONVERSATION_HEADER_NAMES]);
    });

    test('normalizes header maps to lowercase strings', () => {
        expect(normalizeHeaders({ 'X-One': 'a', 'X-Two': ['b', 'c'], 'X-Three': 7, 'X-Four': {} })).toEqual({
            'x-one': 'a',
            'x-two': 'b',
            'x-three': '7'
        });
    });

    test('different identity values, headers or scopes never share a key', () => {
        const base = {
            source: 'header',
            header: 'session-id',
            value: 'conv',
            preview: 'conv',
            startKey: null,
            entryKey: null
        };
        const other = { ...base, value: 'conv-2' };
        const otherHeader = { ...base, header: 'thread-id' };
        expect(conversationKeyFor(base, 'scope')).toHaveLength(64);
        expect(conversationKeyFor(base, 'scope')).toEqual(conversationKeyFor({ ...base }, 'scope'));
        expect(conversationKeyFor(base, 'scope')).not.toEqual(conversationKeyFor(other, 'scope'));
        expect(conversationKeyFor(base, 'scope')).not.toEqual(conversationKeyFor(otherHeader, 'scope'));
        expect(conversationKeyFor(base, 'scope')).not.toEqual(conversationKeyFor(base, 'other-scope'));
        expect(conversationKeyFor({ source: 'derived', header: 'derived', value: null }, 'scope')).toBeNull();
    });

    test('scope carries model, tool mode, tool fingerprint and upstream mode', () => {
        const base = {
            providerID: 'opencode',
            modelID: 'kimi-k2.5',
            toolMode: 'disabled',
            toolFingerprint: '-'
        };
        const direct = conversationScopeFor({ ...base, mode: 'direct' });
        const runtime = conversationScopeFor({ ...base, mode: 'runtime' });
        expect(direct).not.toEqual(runtime);
        expect(direct).not.toEqual(conversationScopeFor({ ...base, toolFingerprint: 'abc', mode: 'direct' }));
        expect(direct).not.toEqual(
            conversationScopeFor({ ...base, toolMode: 'external-bridge', mode: 'direct' })
        );
        expect(direct).not.toEqual(conversationScopeFor({ ...base, modelID: 'gpt-5-nano', mode: 'direct' }));
    });
});

describe('derived conversation identity', () => {
    const opening = [{ role: 'user', content: 'remember the codeword ZEBRA' }];

    test('is off unless derivation is enabled', () => {
        expect(deriveIdentity({ headers: {}, scope: 's', deliverable: opening })).toBeNull();
        expect(deriveIdentity({ headers: {}, scope: 's', deliverable: opening, enabled: false })).toBeNull();
    });

    test('needs something to anchor on', () => {
        expect(deriveIdentity({ headers: {}, scope: 's', deliverable: [], enabled: true })).toBeNull();
    });

    test('anchors on the scope plus the first delivered message', () => {
        const identity = deriveIdentity({ headers: {}, scope: 's', deliverable: opening, enabled: true });
        expect(identity.source).toEqual('derived');
        expect(identity.startKey).toHaveLength(64);
        expect(identity.entryKey).toMatch(/^derived:/u);
        expect(
            deriveIdentity({ headers: {}, scope: 's', deliverable: opening, enabled: true }).startKey
        ).toEqual(identity.startKey);
        expect(
            deriveIdentity({ headers: {}, scope: 'different', deliverable: opening, enabled: true }).startKey
        ).not.toEqual(identity.startKey);
        expect(
            deriveIdentity({
                headers: {},
                scope: 's',
                deliverable: [{ role: 'user', content: 'other' }],
                enabled: true
            }).startKey
        ).not.toEqual(identity.startKey);
    });

    test('gives every fresh candidate its own key', () => {
        const first = deriveIdentity({ headers: {}, scope: 's', deliverable: opening, enabled: true });
        const second = deriveIdentity({ headers: {}, scope: 's', deliverable: opening, enabled: true });
        expect(first.entryKey).not.toEqual(second.entryKey);
    });

    test('separates clients by credential and by forwarded address', () => {
        const bare = derivedScopeFor({ headers: {}, scope: 's' });
        const keyed = derivedScopeFor({ headers: { authorization: 'Bearer a' }, scope: 's' });
        const other = derivedScopeFor({ headers: { authorization: 'Bearer b' }, scope: 's' });
        const forwarded = derivedScopeFor({
            headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
            scope: 's'
        });
        expect(bare).not.toEqual(keyed);
        expect(keyed).not.toEqual(other);
        expect(bare).not.toEqual(forwarded);
        // Only the first hop counts, and it is the address a socket-level caller
        // would have passed in directly.
        expect(
            derivedScopeFor({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, scope: 's' })
        ).toEqual(forwarded);
        expect(derivedScopeFor({ headers: {}, scope: 's', clientAddress: '203.0.113.9' })).toEqual(forwarded);
        expect(derivedScopeFor({ headers: {}, scope: 's', clientAddress: '198.51.100.7' })).not.toEqual(
            forwarded
        );
    });
});

describe('derived conversation lookup', () => {
    const history = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'more' }
    ];
    // A session that received the opening turn holds one delivered message; the
    // next request echoes the answer as message index 1.
    const candidate = (key, overrides) => ({
        key,
        entry: entry({
            sentCount: 1,
            sentDigest: prefixDigest(history, 1),
            replyDigest: replyDigestFor('hi there'),
            ...overrides
        })
    });

    test('recognises the single candidate whose prefix matches', () => {
        const found = matchDerivedEntry({ deliverable: history, candidates: [candidate('a')] });
        expect(found.key).toEqual('a');
    });

    test('ignores a candidate whose stored prefix does not match', () => {
        const found = matchDerivedEntry({
            deliverable: [
                { role: 'user', content: 'a different opening' },
                { role: 'assistant', content: 'hi there' },
                { role: 'user', content: 'more' }
            ],
            candidates: [candidate('a')]
        });
        expect(found).toBeNull();
    });

    test('refuses when a replayed history carries nothing new', () => {
        expect(
            matchDerivedEntry({ deliverable: history.slice(0, 1), candidates: [candidate('a')] })
        ).toBeNull();
    });

    test('uses the echoed answer to pick between look-alikes', () => {
        const result = matchDerivedEntry({
            deliverable: history,
            candidates: [
                candidate('a'),
                candidate('b', { replyDigest: replyDigestFor('a different answer'), sessionId: 'session-2' })
            ]
        });
        expect(result.key).toEqual('a');
    });

    test('refuses to merge two look-alikes it cannot tell apart', () => {
        expect(
            matchDerivedEntry({ deliverable: history, candidates: [candidate('a'), candidate('b')] })
        ).toBeNull();
    });
});
