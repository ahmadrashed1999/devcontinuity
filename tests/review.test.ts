import { describe, expect, it } from 'vitest';

describe('review before sharing', () => {
  it('splits at headings outside code fences and reassembles exactly', async () => {
    const { assemble, splitSections } = await import('../src/lib/review');
    const text = '# Continue: shop\nintro\n\n## Last request\n```\n## not a heading\n```\n\n## Errors\nboom';
    const s = splitSections(text);
    expect(s.map((x) => x.title)).toEqual(['Continue: shop', 'Last request', 'Errors']);
    expect(assemble(s, [])).toBe(text);
    expect(assemble(s, [s[2].id])).not.toContain('boom');
  });

  it('highlights redactions, secret-like strings, e-mails and home paths, but not commit hashes', async () => {
    const { findSensitive, summarize } = await import('../src/lib/review');
    const text = [
      'key [REDACTED:api-key] here',
      'token abcdEFGH1234ijklMNOP5678qrstUVWX9012yz',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'by dev@example.com in C:\\Users\\alice\\code and /home/bob/x',
      'password: hunter22',
    ].join('\n');
    const s = summarize(findSensitive(text));
    expect(s).toEqual({ redacted: 1, secret: 2, email: 1, path: 2 });
    expect(findSensitive('id 123e4567-e89b-12d3-a456-426614174000')).toEqual([]);
  });

  it('applies reviewed file texts and omissions to a handoff package, keeping the README', async () => {
    const { applyOverrides } = await import('../src/server/handoff/package');
    const files = { 'README.md': 'r', 'prompts/codex.md': 'p', 'GIT_STATE.md': 'g' };
    expect(applyOverrides(files, { 'prompts/codex.md': 'edited', 'GIT_STATE.md': null, 'README.md': null, 'evil/../x.md': 'x' })).toEqual({ 'README.md': 'r', 'prompts/codex.md': 'edited' });
  });
});
