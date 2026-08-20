// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Central timeout budget for everything that can block.
 *
 * Kept in one place on purpose: these numbers are the difference between "YAAM
 * reports a problem" and "YAAM hangs forever", so they should be reviewable at
 * a glance rather than scattered as magic numbers across modules.
 *
 * Rule of thumb for picking a value: take the worst realistic duration on a
 * slow machine and give it generous headroom.  A timeout that fires during
 * normal use is worse than no timeout at all — it turns a working feature into
 * a flaky one.
 */
export const TIMEOUTS = {
  net: {
    /** TCP/TLS connection establishment.  A reachable host answers in well
     *  under a second; anything near this is a firewall or a DNS blackhole. */
    connect: 15_000,
    /** No bytes moved on an established connection. */
    idle: 20_000,
    /** Whole request for the big catalog file (~2.5 MB, normally < 1 s). */
    catalog: 120_000,
    /** Whole request for the small JSON/HTML endpoints. */
    small: 30_000,
  },
  fs: {
    /** Full addon scan.  Hundreds of addons on a slow disk stay far below. */
    scan: 60_000,
    /** Parsing AddonSettings.txt — a single file. */
    settings: 30_000,
    /** Enumerating SavedVariables; these files can be large. */
    savedVars: 60_000,
    /** Unpacking an addon archive and recording it in the database. */
    install: 120_000,
    /** Copying whole folders or building/reading profile ZIPs — the slowest
     *  things YAAM does, and worth waiting for rather than aborting early. */
    backup: 300_000,
    /** Deletes, listings and previews: little work, no excuse to be slow. */
    quick: 30_000,
  },
} as const;
