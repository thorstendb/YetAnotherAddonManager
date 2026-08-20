// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Wire protocol between the main process and the filesystem worker.
 *
 * Deliberately its own module with no imports: both sides need these values at
 * runtime, and if the host pulled them from fsWorker.ts it would load the
 * worker module — and with it every filesystem module — into the main process,
 * where the worker's parentPort guard throws on import.  A type-only import
 * disappears at build time; a value import does not.
 */

/**
 * Placeholder the host substitutes for a progress callback.
 *
 * Functions cannot cross a thread boundary, so the host replaces any callback
 * argument with this marker and the worker turns it back into a function that
 * posts progress messages home.  Position-independent by design — it works for
 * any operation regardless of where its callback sits in the signature.
 */
export const PROGRESS_MARKER = '__yaam_progress_callback__';

export interface FsRequest {
  id: number;
  op: string;
  args: unknown[];
}

export type FsResponse =
  | { id: number; kind: 'result'; ok: true; value: unknown }
  | { id: number; kind: 'result'; ok: false; error: string }
  | { id: number; kind: 'progress'; args: unknown[] };
