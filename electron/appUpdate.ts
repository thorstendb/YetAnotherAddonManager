// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * "Is there a newer YAAM?" — a check and a link, nothing more.
 *
 * No auto-update on purpose: the Windows and macOS builds are unsigned, so an
 * updater could not verify what it installs.  The user gets the release page
 * instead of a direct binary, sees what they download, and picks the asset for
 * their platform themselves.
 */
import { fetchUrl } from './addonCatalogApi';
import { TIMEOUTS } from './shared/timeouts';
import { compareAppVersions } from './shared/appVersion';
import type { AppUpdateCheck } from './shared/types';

export type { AppUpdateCheck };

const RELEASES_API = 'https://api.github.com/repos/thorstendb/YetAnotherAddonManager/releases/latest';
export const RELEASES_PAGE = 'https://github.com/thorstendb/YetAnotherAddonManager/releases/latest';
export const REPO_PAGE = 'https://github.com/thorstendb/YetAnotherAddonManager';

/**
 * Ask GitHub for the latest published release.  `/releases/latest` skips
 * drafts and pre-releases, so a release still being prepared never triggers a
 * notice.  `fetchJson` is injectable for tests.
 */
export async function checkForAppUpdate(
  current: string,
  fetchJson: (url: string) => Promise<string> = (url) =>
    fetchUrl(url, { totalTimeoutMs: TIMEOUTS.net.small }),
): Promise<AppUpdateCheck> {
  const result: AppUpdateCheck = { current, newer: false, url: RELEASES_PAGE };
  try {
    const release = JSON.parse(await fetchJson(RELEASES_API)) as { tag_name?: string; html_url?: string };
    const latest = (release.tag_name ?? '').trim().replace(/^v/i, '');
    if (!latest) return { ...result, error: 'GitHub returned no release version' };
    result.latest = latest;
    result.newer = compareAppVersions(latest, current) > 0;
    // Only a GitHub page may be opened from here — the URL comes off the network
    if (release.html_url?.startsWith('https://github.com/')) result.url = release.html_url;
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 403/.test(msg)) return { ...result, error: 'GitHub rate limit reached — try again in a while' };
    if (/HTTP 404/.test(msg)) return { ...result, error: 'No published release found on GitHub' };
    return { ...result, error: msg };
  }
}
