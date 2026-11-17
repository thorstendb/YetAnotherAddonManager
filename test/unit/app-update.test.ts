// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { compareAppVersions } from '../../electron/shared/appVersion';
import { checkForAppUpdate, RELEASES_PAGE } from '../../electron/appUpdate';

describe('compareAppVersions', () => {
  it('orders plain releases numerically, not as strings', () => {
    expect(compareAppVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareAppVersions('0.5.0', '0.5.1')).toBeLessThan(0);
    expect(compareAppVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('ignores the tag prefix and missing trailing parts', () => {
    expect(compareAppVersions('v0.5.0', '0.5.0')).toBe(0);
    expect(compareAppVersions('0.5', '0.5.0')).toBe(0);
  });

  it('ranks a release above its own pre-releases', () => {
    expect(compareAppVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareAppVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
  });

  it('never calls an unreadable version newer', () => {
    // The only thing riding on this is "tell the user to update" — it must not fire on garbage
    expect(compareAppVersions('latest', '0.5.0')).toBe(0);
    expect(compareAppVersions('0.6.0', '')).toBe(0);
  });
});

describe('checkForAppUpdate', () => {
  const github = (body: object) => async () => JSON.stringify(body);

  it('reports a newer release and its page', async () => {
    const res = await checkForAppUpdate('0.5.0', github({
      tag_name: 'v0.6.0', html_url: 'https://github.com/thorstendb/YetAnotherAddonManager/releases/tag/v0.6.0',
    }));
    expect(res).toMatchObject({ current: '0.5.0', latest: '0.6.0', newer: true });
    expect(res.url).toContain('/releases/tag/v0.6.0');
  });

  it('stays quiet when the running build is current or ahead', async () => {
    expect((await checkForAppUpdate('0.5.0', github({ tag_name: 'v0.5.0' }))).newer).toBe(false);
    expect((await checkForAppUpdate('0.6.0', github({ tag_name: 'v0.5.0' }))).newer).toBe(false);
  });

  it('opens only GitHub pages — the URL comes off the network', async () => {
    const res = await checkForAppUpdate('0.5.0', github({ tag_name: 'v0.6.0', html_url: 'https://evil.example/yaam.exe' }));
    expect(res.newer).toBe(true);
    expect(res.url).toBe(RELEASES_PAGE);
  });

  it('turns GitHub failures into readable errors, never into "newer"', async () => {
    const failing = (msg: string) => async () => { throw new Error(msg); };
    const limited = await checkForAppUpdate('0.5.0', failing('HTTP 403 for https://api.github.com/…'));
    expect(limited).toMatchObject({ newer: false, error: expect.stringContaining('rate limit') });
    const none = await checkForAppUpdate('0.5.0', failing('HTTP 404 for https://api.github.com/…'));
    expect(none.error).toContain('No published release');
    const garbage = await checkForAppUpdate('0.5.0', async () => 'not json');
    expect(garbage.newer).toBe(false);
    expect(garbage.error).toBeTruthy();
  });
});
