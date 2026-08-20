// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Host side of the filesystem worker (see fsWorker.ts for the why).
 *
 * Provides callFs(), a typed RPC with a real timeout: if the worker does not
 * answer in time it is assumed to be stuck in a blocking syscall, gets
 * terminated, and is restarted on the next call.  That is the one thing the
 * main process cannot do for itself.
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
// Type-only: erased at build time, so the worker module is never loaded here.
import type { FsOps, FsOpName } from './fsWorker';
import { PROGRESS_MARKER, FsRequest, FsResponse } from './shared/fsProtocol';
import { TIMEOUTS } from './shared/timeouts';

/** Fallback for callers that do not pass one; see shared/timeouts.ts. */
export const DEFAULT_FS_TIMEOUT_MS = TIMEOUTS.fs.scan;

interface PendingCall {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
  /** Callback argument that could not be sent across the boundary. */
  onProgress?: (...args: unknown[]) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();

function workerPath(): string {
  // main.js and fsWorker.js are emitted side by side into dist-electron/.
  // The override exists for tests and unusual packaging layouts.
  return process.env.YAAM_FS_WORKER_PATH || path.join(__dirname, 'fsWorker.js');
}

/** Reject every in-flight call — used when the worker dies or is terminated. */
function failAllPending(reason: string): void {
  for (const [, call] of pending) {
    clearTimeout(call.timer);
    call.reject(new Error(reason));
  }
  pending.clear();
}

/** Drop the current worker.  The next call transparently starts a fresh one. */
function discardWorker(reason: string): void {
  const dying = worker;
  worker = null;
  failAllPending(reason);
  if (dying) {
    // terminate() is safe here: YAAM's JSON writes go through a temp file and
    // an atomic rename, so a half-written database is not possible.
    dying.terminate().catch(() => { /* already gone */ });
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(workerPath());
  w.on('message', (res: FsResponse) => {
    const call = pending.get(res.id);
    if (!call) return; // timed out earlier — response no longer wanted
    if (res.kind === 'progress') {
      call.onProgress?.(...res.args);
      return; // still running
    }
    pending.delete(res.id);
    clearTimeout(call.timer);
    if (res.ok) {
      (call.resolve as (v: unknown) => void)(res.value);
    } else {
      call.reject(new Error(res.error));
    }
  });
  w.on('error', (err: Error) => {
    console.error('[YAAM] fsWorker error:', err);
    discardWorker(`Filesystem worker crashed: ${err.message}`);
  });
  w.on('exit', (code) => {
    if (worker === w) {
      worker = null;
      if (code !== 0) failAllPending(`Filesystem worker exited with code ${code}`);
    }
  });
  worker = w;
  return w;
}

/**
 * Run a filesystem operation in the worker.
 *
 * Rejects if the operation throws, if the worker dies, or if it does not
 * answer within timeoutMs — in the last case the worker is terminated, since a
 * thread blocked in a syscall never becomes usable again.
 */
export function callFs<K extends FsOpName>(
  op: K,
  args: Parameters<FsOps[K]>,
  timeoutMs: number = DEFAULT_FS_TIMEOUT_MS
): Promise<ReturnType<FsOps[K]>> {
  return new Promise<ReturnType<FsOps[K]>>((resolve, reject) => {
    let w: Worker;
    try {
      w = ensureWorker();
    } catch (err: unknown) {
      reject(new Error(`Could not start filesystem worker: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      discardWorker(`Filesystem worker terminated after ${timeoutMs / 1000}s (operation "${op}")`);
      reject(new Error(
        `"${op}" did not finish within ${timeoutMs / 1000}s and was aborted. ` +
        'This usually means the AddOns folder is on OneDrive ("Files On-Demand"), ' +
        'a network share, or a drive that stopped responding.'
      ));
    }, timeoutMs);

    // Strip callbacks: they cannot be cloned.  The worker recreates them from
    // the marker and posts progress back, which is dispatched above.
    let onProgress: ((...a: unknown[]) => void) | undefined;
    const wireArgs = (args as unknown[]).map((a) => {
      if (typeof a === 'function') {
        onProgress = a as (...a: unknown[]) => void;
        return PROGRESS_MARKER;
      }
      return a;
    });

    pending.set(id, { resolve: resolve as (v: never) => void, reject, timer, op, onProgress });
    w.postMessage({ id, op, args: wireArgs } satisfies FsRequest);
  });
}

/** Shut the worker down (called on app quit). */
export function shutdownFsWorker(): void {
  discardWorker('Application is shutting down');
}
