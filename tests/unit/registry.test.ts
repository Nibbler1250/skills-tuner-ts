import { describe, test, expect } from 'bun:test';
import { Registry } from '../../src/core/registry.js';
import { TunableSubject, Adapter } from '../../src/core/interfaces.js';
import type { Cluster, Observation, Patch, Proposal, ValidationResult } from '../../src/core/types.js';

class FakeSubject extends TunableSubject {
  readonly name = 'fake';
  async collectObservations(_since: Date): Promise<Observation[]> { return []; }
  async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
  async proposeChange(_cluster: Cluster): Promise<Proposal> { throw new Error('not impl'); }
  async apply(_proposal: Proposal, _alt: string): Promise<Patch> { throw new Error('not impl'); }
  async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
}

class AnotherSubject extends TunableSubject {
  readonly name = 'another';
  async collectObservations(_since: Date): Promise<Observation[]> { return []; }
  async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
  async proposeChange(_cluster: Cluster): Promise<Proposal> { throw new Error('not impl'); }
  async apply(_proposal: Proposal, _alt: string): Promise<Patch> { throw new Error('not impl'); }
  async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
}

class FakeAdapter extends Adapter {
  async renderProposal(_p: Proposal): Promise<void> {}
  async renderApplyConfirmation(_p: Proposal, _alt: string): Promise<void> {}
}

describe('Registry', () => {
  test('registerSubject and getSubject', () => {
    const reg = new Registry();
    const s = new FakeSubject();
    reg.registerSubject(s);
    expect(reg.getSubject('fake')).toBe(s);
  });

  test('getSubject returns undefined for unknown', () => {
    const reg = new Registry();
    expect(reg.getSubject('unknown')).toBeUndefined();
  });

  test('registerAdapter and getAdapter', () => {
    const reg = new Registry();
    const a = new FakeAdapter();
    reg.registerAdapter('cli', a);
    expect(reg.getAdapter('cli')).toBe(a);
  });

  test('getAdapter returns undefined for unknown', () => {
    const reg = new Registry();
    expect(reg.getAdapter('missing')).toBeUndefined();
  });

  test('allSubjects returns all registered subjects', () => {
    const reg = new Registry();
    const s1 = new FakeSubject();
    const s2 = new AnotherSubject();
    reg.registerSubject(s1);
    reg.registerSubject(s2);
    const all = reg.allSubjects();
    expect(all).toHaveLength(2);
    expect(all).toContain(s1);
    expect(all).toContain(s2);
  });

  test('enabledSubjects filters out disabled subjects', () => {
    const reg = new Registry();
    reg.registerSubject(new FakeSubject());
    const enabled = reg.enabledSubjects({ subjects: { fake: { enabled: true } } });
    expect(enabled).toHaveLength(1);
    const disabled = reg.enabledSubjects({ subjects: { fake: { enabled: false } } });
    expect(disabled).toHaveLength(0);
  });

  test('enabledSubjects includes subjects with no config entry', () => {
    const reg = new Registry();
    reg.registerSubject(new FakeSubject());
    const all = reg.enabledSubjects({ subjects: {} });
    expect(all).toHaveLength(1);
  });

  test('enabledSubjects handles multiple subjects with mixed config', () => {
    const reg = new Registry();
    reg.registerSubject(new FakeSubject());
    reg.registerSubject(new AnotherSubject());
    const result = reg.enabledSubjects({ subjects: { fake: { enabled: false }, another: { enabled: true } } });
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('another');
  });

  test('registerSubject overwrites existing subject with same name', () => {
    const reg = new Registry();
    const s1 = new FakeSubject();
    const s2 = new FakeSubject();
    reg.registerSubject(s1);
    reg.registerSubject(s2);
    expect(reg.getSubject('fake')).toBe(s2);
    expect(reg.allSubjects()).toHaveLength(1);
  });

  test('enabledSubjects with undefined subjects config', () => {
    const reg = new Registry();
    reg.registerSubject(new FakeSubject());
    const all = reg.enabledSubjects({ subjects: undefined as unknown as Record<string, { enabled?: boolean }> });
    expect(all).toHaveLength(1);
  });
});
