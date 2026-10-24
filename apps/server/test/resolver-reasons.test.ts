import { expect,it } from 'vitest';
import { classifyError } from '../src/public/ytdlp.ts';

it('does not confuse webpage/package/message errors with age restrictions or a login requirement',()=>{
  expect(classifyError('ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable').kind).toBe('timeout');
  expect(classifyError('ERROR: Unable to download webpage: connection timed out').kind).toBe('timeout');
  expect(classifyError('ERROR: package message: unsupported response').kind).toBe('failed');
  expect(classifyError('ERROR: Unable to download webpage: HTTP Error 429').kind).toBe('timeout');
  expect(classifyError('ERROR: Sign in to confirm your age').kind).toBe('auth');
  expect(classifyError('ERROR: age-restricted video').kind).toBe('auth');
  expect(classifyError("ERROR: Sign in to confirm you’re not a bot").message).toContain('ботов');
  expect(classifyError('ERROR: blocked by anti-bot protection').message).not.toContain('стране');
  expect(classifyError('ERROR: not available in your country').kind).toBe('unavailable');
});
