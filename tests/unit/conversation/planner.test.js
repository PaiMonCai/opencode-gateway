import {
    canonicalMessageFingerprint,
    deliverableMessages,
    hashMessage,
    planConversationTurn,
    planPinnedTurn,
    planRotationTurn,
    prefixDigest,
    replyDigestFor,
    toolsFingerprintFor
} from '../../../src/conversation/planner.js';

/** A stored entry for a session that already received `count` messages. */
const storedEntry = (messages, count, overrides = {}) => ({
    sessionId: 'session-1',
    mode: 'runtime',
    sentCount: count,
    sentDigest: prefixDigest(messages, count),
    replyDigest: null,
    startKey: null,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides
});

const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' }
];

describe('message fingerprints', () => {
    test('ignore key order, in the envelope and in nested content', () => {
        const a = { role: 'user', content: [{ type: 'text', text: 'hello' }], name: 'n' };
        const b = { name: 'n', content: [{ text: 'hello', type: 'text' }], role: 'user' };
        expect(canonicalMessageFingerprint(a)).toEqual(canonicalMessageFingerprint(b));
        expect(hashMessage(a)).toEqual(hashMessage(b));
    });

    test('ignore fields the proxy never forwards', () => {
        const a = { role: 'user', content: 'hello', cache_control: { type: 'ephemeral' } };
        const b = { role: 'user', content: 'hello', extra: 1 };
        expect(hashMessage(a)).toEqual(hashMessage(b));
    });

    test('are case-insensitive on the role', () => {
        expect(hashMessage({ role: 'USER', content: 'x' })).toEqual(
            hashMessage({ role: 'user', content: 'x' })
        );
    });

    test('distinguish tool calls by id, name and arguments', () => {
        const call = (id, name, args) => ({
            role: 'assistant',
            content: null,
            tool_calls: [{ id, function: { name, arguments: args } }]
        });
        expect(hashMessage(call('1', 'web_fetch', '{}'))).not.toEqual(
            hashMessage(call('2', 'web_fetch', '{}'))
        );
        expect(hashMessage(call('1', 'web_fetch', '{}'))).not.toEqual(hashMessage(call('1', 'bash', '{}')));
        expect(hashMessage(call('1', 'web_fetch', '{}'))).not.toEqual(
            hashMessage(call('1', 'web_fetch', '{"a":1}'))
        );
        expect(hashMessage(call('1', 'web_fetch', '{}'))).toEqual(hashMessage(call('1', 'web_fetch', '{}')));
    });

    test('reply digest only covers text answers', () => {
        expect(replyDigestFor('hi')).toEqual(hashMessage({ role: 'assistant', content: 'hi' }));
        expect(replyDigestFor(undefined)).toBeNull();
        expect(replyDigestFor(null)).toBeNull();
    });
});

describe('prefix digest', () => {
    test('is stable for identical prefixes and independent of the tail', () => {
        const prefix = history.slice(0, 2);
        expect(prefixDigest(prefix, 2)).toEqual(prefixDigest(history, 2));
        expect(prefixDigest(prefix, 2)).not.toEqual(prefixDigest(history, 3));
    });

    test('changes on an edit at any position', () => {
        const baseline = prefixDigest(history, 3);
        const editedHead = [{ role: 'user', content: 'EDITED' }, history[1], history[2]];
        const editedMiddle = [history[0], { role: 'assistant', content: 'EDITED' }, history[2]];
        const editedTail = [history[0], history[1], { role: 'user', content: 'EDITED' }];
        for (const edited of [editedHead, editedMiddle, editedTail]) {
            expect(prefixDigest(edited, 3)).not.toEqual(baseline);
        }
    });

    test('changes on reorder and on truncation', () => {
        const reordered = [history[1], history[0], history[2]];
        expect(prefixDigest(reordered, 3)).not.toEqual(prefixDigest(history, 3));
        expect(prefixDigest(history, 2)).not.toEqual(prefixDigest(history, 3));
    });

    test('is bounded by the available messages', () => {
        expect(prefixDigest(history, 99)).toEqual(prefixDigest(history, 3));
        expect(prefixDigest(history, 0)).toEqual(prefixDigest([], 0));
    });
});

describe('tool fingerprint', () => {
    test('is empty when the request carries no tools', () => {
        expect(toolsFingerprintFor(undefined, undefined)).toEqual('-');
        expect(toolsFingerprintFor([], undefined)).toEqual('-');
    });

    test('is order independent and choice sensitive', () => {
        const tools = [
            { type: 'function', function: { name: 'web_fetch' } },
            { type: 'function', function: { name: 'bash' } }
        ];
        const reversed = [tools[1], tools[0]];
        expect(toolsFingerprintFor(tools, 'auto')).toEqual(toolsFingerprintFor(reversed, 'auto'));
        expect(toolsFingerprintFor(tools, 'auto')).not.toEqual(toolsFingerprintFor(tools, 'required'));
        expect(toolsFingerprintFor(tools, { type: 'function', function: { name: 'bash' } })).not.toEqual(
            toolsFingerprintFor(tools, 'auto')
        );
    });
});

describe('planConversationTurn', () => {
    test('sends the whole history for a conversation with no stored session', () => {
        const plan = planConversationTurn(null, history);
        expect(plan.reuse).toBe(false);
        expect(plan.rewrite).toBe(false);
        expect(plan.pinned).toBe(false);
        expect(plan.delta).toEqual(history);
        expect(plan.deltaStartIndex).toEqual(0);
        expect(plan.sentCount).toEqual(3);
        expect(plan.sentDigest).toEqual(prefixDigest(history, 3));
    });

    test('reuses a session and sends only the appended turns', () => {
        const extended = [...history, { role: 'user', content: 'third question' }];
        const plan = planConversationTurn(storedEntry(history, 3), extended);
        expect(plan.reuse).toBe(true);
        expect(plan.rewrite).toBe(false);
        expect(plan.delta).toEqual([{ role: 'user', content: 'third question' }]);
        expect(plan.deltaStartIndex).toEqual(3);
        expect(plan.sentCount).toEqual(4);
        expect(plan.sentDigest).toEqual(prefixDigest(extended, 4));
    });

    test('does not re-send the echoed answer the session already produced', () => {
        const echoed = [
            ...history,
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'third question' }
        ];
        const plan = planConversationTurn(storedEntry(history, 3), echoed);
        expect(plan.reuse).toBe(true);
        expect(plan.delta).toEqual([{ role: 'user', content: 'third question' }]);
        expect(plan.deltaStartIndex).toEqual(4);
        expect(plan.sentCount).toEqual(5);
    });

    test('rotates, with the full history, when the delta is nothing but an echo', () => {
        const echoed = [...history, { role: 'assistant', content: 'second answer' }];
        const plan = planConversationTurn(storedEntry(history, 3), echoed);
        expect(plan.reuse).toBe(false);
        expect(plan.rewrite).toBe(true);
        expect(plan.delta).toEqual(echoed);
        expect(plan.deltaStartIndex).toEqual(0);
        expect(plan.sentCount).toEqual(4);
    });

    test('rotates when the client replays the same history', () => {
        const plan = planConversationTurn(storedEntry(history, 3), history);
        expect(plan.reuse).toBe(false);
        expect(plan.rewrite).toBe(true);
        expect(plan.delta).toEqual(history);
    });

    test('rotates when the prefix is edited anywhere, not just at the tail', () => {
        const editedHead = [
            { role: 'user', content: 'EDITED' },
            history[1],
            history[2],
            { role: 'user', content: 'new' }
        ];
        const editedMiddle = [
            history[0],
            { role: 'assistant', content: 'EDITED' },
            history[2],
            { role: 'user', content: 'new' }
        ];
        for (const edited of [editedHead, editedMiddle]) {
            const plan = planConversationTurn(storedEntry(history, 3), edited);
            expect(plan.reuse).toBe(false);
            expect(plan.rewrite).toBe(true);
            expect(plan.delta).toEqual(edited);
            expect(plan.deltaStartIndex).toEqual(0);
        }
    });

    test('rotates when the prefix is reordered or truncated', () => {
        const reordered = [history[1], history[0], history[2], { role: 'user', content: 'new' }];
        const truncated = [history[0], { role: 'user', content: 'new' }];
        for (const rewritten of [reordered, truncated]) {
            expect(planConversationTurn(storedEntry(history, 3), rewritten).reuse).toBe(false);
        }
    });

    test('never trusts an entry without a sent count', () => {
        const plan = planConversationTurn(storedEntry(history, 0), [
            ...history,
            { role: 'user', content: 'new' }
        ]);
        expect(plan.reuse).toBe(false);
        expect(plan.rewrite).toBe(true);
        expect(plan.delta).toHaveLength(4);
    });
});

describe('rotation and pinned plans', () => {
    test('a retry that rotates re-sends the full history', () => {
        const extended = [
            ...history,
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'third question' }
        ];
        const plan = planRotationTurn(extended);
        expect(plan.rotation).toBe(true);
        expect(plan.reuse).toBe(false);
        expect(plan.delta).toEqual(extended);
        expect(plan.deltaStartIndex).toEqual(0);
        expect(plan.sentCount).toEqual(5);
        // A reused session would have sent only the tail; the rotation ignores it.
        expect(planRotationTurn(extended).delta).not.toEqual(
            planConversationTurn(storedEntry(history, 3), extended).delta
        );
    });

    test('a pinned turn sends this turn in full and requires a baseline', () => {
        const plan = planPinnedTurn(history);
        expect(plan.pinned).toBe(true);
        expect(plan.reuse).toBe(true);
        expect(plan.delta).toEqual(history);
        expect(plan.deltaStartIndex).toEqual(0);
        expect(plan.sentDigest).toEqual(prefixDigest(history, 3));
    });
});

describe('deliverable messages', () => {
    test('drops system messages, which are rebuilt every turn', () => {
        const messages = [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hello' },
            { role: 'SYSTEM', content: 'another' },
            { role: 'assistant', content: 'hi' }
        ];
        expect(deliverableMessages(messages)).toEqual([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' }
        ]);
    });

    test('tolerates a missing list', () => {
        expect(deliverableMessages(undefined)).toEqual([]);
    });
});
