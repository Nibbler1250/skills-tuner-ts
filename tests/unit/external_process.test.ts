import { describe, test, expect, afterEach } from 'bun:test';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExternalProcessSubject } from '../../src/subjects/external_process.js';

const cleanupDirs: string[] = [];

function makeMockScript(behavior: 'echo' | 'error' | 'invalid' | 'hang' | 'exit1', response?: unknown): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'tuner-mock-'));
  cleanupDirs.push(dir);
  const script = join(dir, 'mock.sh');
  let body: string;
  if (behavior === 'echo') {
    const escaped = JSON.stringify({ result: response }).replace(/'/g, "'\\''");
    body = `#!/bin/bash\ncat > /dev/null\necho '${escaped}'`;
  } else if (behavior === 'error') {
    body = `#!/bin/bash\ncat > /dev/null\necho '{"error":"mock error"}'`;
  } else if (behavior === 'invalid') {
    body = `#!/bin/bash\ncat > /dev/null\necho 'not json'`;
  } else if (behavior === 'hang') {
    body = `#!/bin/bash\nsleep 60`;
  } else {
    body = `#!/bin/bash\ncat > /dev/null\necho 'broken' >&2\nexit 1`;
  }
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return ['bash', script];
}

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) {
    try { rmSync(d, { recursive: true }); } catch {}
  }
});

describe('ExternalProcessSubject', () => {
  test('callMethod round-trip: returns result', async () => {
    const cmd = makeMockScript('echo', []);
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    const obs = await subj.collectObservations(new Date());
    expect(obs).toEqual([]);
  });

  test('error response throws with message', async () => {
    const cmd = makeMockScript('error');
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    await expect(subj.collectObservations(new Date())).rejects.toThrow('mock error');
  });

  test('invalid JSON throws', async () => {
    const cmd = makeMockScript('invalid');
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    await expect(subj.collectObservations(new Date())).rejects.toThrow('invalid JSON');
  });

  test('non-zero exit throws with exit code', async () => {
    const cmd = makeMockScript('exit1');
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    await expect(subj.collectObservations(new Date())).rejects.toThrow('exited');
  });

  test('timeout throws timed out error', async () => {
    const cmd = makeMockScript('hang');
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd, timeoutMs: 200 });
    await expect(subj.collectObservations(new Date())).rejects.toThrow('timed out');
  }, 5000);

  test('collectObservations returns validated array', async () => {
    const obs = [{
      session_id: 's1',
      observed_at: new Date().toISOString(),
      signal_type: 'correction',
      verbatim: 'test',
      metadata: {},
    }];
    const cmd = makeMockScript('echo', obs);
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    const result = await subj.collectObservations(new Date());
    expect(result).toHaveLength(1);
    expect(result[0]!.signal_type).toBe('correction');
  });

  test('proposeChange throws if schema invalid', async () => {
    const cmd = makeMockScript('echo', { not_a_proposal: true });
    const subj = new ExternalProcessSubject({ name: 'test', command: cmd });
    await expect(subj.proposeChange({
      id: 'c1', subject: 'test', observations: [], frequency: 1, success_rate: 0.5, sentiment: 'neutral', subjects_touched: [],
    })).rejects.toThrow();
  });

  test('default risk_tier is high', () => {
    const subj = new ExternalProcessSubject({ name: 'ext', command: ['echo', '{}'] });
    expect(subj.risk_tier).toBe('high');
  });
});
