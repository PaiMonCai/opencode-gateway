import { describe, expect, test } from '@jest/globals';

import { createChatPromptBuilder } from '../../../src/routes/chat-prompt.js';

describe('Chat prompt builder', () => {
    test('renders system, transcript and last user message', async () => {
        const build = createChatPromptBuilder();
        const result = await build([
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'again' }
        ]);

        expect(result.system).toBe('rules');
        expect(result.fullPromptText).toBe('USER: hello\n\nASSISTANT: hi\n\nUSER: again');
        expect(result.lastUserMsg).toBe('again');
        expect(result.parts).toEqual([
            { type: 'text', text: 'USER: hello' },
            { type: 'text', text: 'ASSISTANT: hi' },
            { type: 'text', text: 'USER: again' }
        ]);
    });

    test('honors includeFromIndex while preserving full history text', async () => {
        const build = createChatPromptBuilder();
        const result = await build(
            [
                { role: 'user', content: 'old' },
                { role: 'assistant', content: 'old answer' },
                { role: 'user', content: 'new' }
            ],
            [],
            { includeFromIndex: 2 }
        );

        expect(result.parts).toEqual([{ type: 'text', text: 'USER: new' }]);
        expect(result.fullPromptText).toContain('USER: old');
        expect(result.fullPromptText).toContain('USER: new');
    });
});
