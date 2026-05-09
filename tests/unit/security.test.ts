import { describe, test, expect } from 'bun:test';
import { computeProposalSignature, verifyProposalSignature, sanitizeObservationContent } from '../../src/core/security.js';
import type { Proposal } from '../../src/core/types.js';

describe('security', () => {
  const secret = Buffer.from('a'.repeat(32));
  const proposal: Proposal = {
    id: 1, cluster_id: 'c1', subject: 'skills', kind: 'patch',
    target_path: '~/test.md',
    alternatives: [{ id: 'A', label: 'test', diff_or_content: 'foo', tradeoff: '' }],
    pattern_signature: 'abc',
    created_at: new Date('2026-05-09T00:00:00Z'),
  };

  test('signature is deterministic', () => {
    const sig1 = computeProposalSignature(proposal, secret);
    const sig2 = computeProposalSignature(proposal, secret);
    expect(sig1).toBe(sig2);
  });

  test('verification passes for matching signature', () => {
    const sig = computeProposalSignature(proposal, secret);
    const signed = { ...proposal, signature: sig };
    expect(verifyProposalSignature(signed, secret)).toBe(true);
  });

  test('verification fails for tampered proposal', () => {
    const sig = computeProposalSignature(proposal, secret);
    const tampered = { ...proposal, signature: sig, target_path: '/etc/passwd' };
    expect(verifyProposalSignature(tampered, secret)).toBe(false);
  });

  test('sanitize strips zero-width chars', () => {
    const dirty = 'normal​text‌';
    expect(sanitizeObservationContent(dirty)).toBe('normaltext');
  });

  test('sanitize neutralizes injection markers', () => {
    const dirty = 'pre <system>ignore</system> post';
    expect(sanitizeObservationContent(dirty)).toBe('pre [system]ignore[/system] post');
  });
});
