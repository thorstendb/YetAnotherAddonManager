// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';
import { BundledLibReport } from '../../electron/shared/types';

export interface HygieneStray {
  file: string;
  addonName: string;
  title: string;
  version: string;
  addonVersion: number;
  relatedFiles: string[];
  folderExists: boolean;
  folderVersion: string;
  rootIsStale: boolean;
}

export interface HygieneDup {
  relPath: string;
  originalRelPath: string;
  isDirectory: boolean;
}



/** A fix YAAM can offer for a bundled-library problem — the user decides. */
export interface HygieneFix {
  /** Stable key; the selection travels back as these */
  key: string;
  /** What the checkbox says */
  label: string;
  /** Why it is offered */
  detail: string;
  /** Preselected: an ordinary update is, switching to another author's fork is not */
  recommended: boolean;
}

interface HygieneDialogProps {
  strayManifests: HygieneStray[];
  duplicates: HygieneDup[];
  unclaimedRootFiles: string[];
  bundledLibs: BundledLibReport[];
  fixes?: HygieneFix[];
  onConfirm: (actions: { repairs: string[]; removals: string[]; fixes: string[] }) => void;
  onCancel: () => void;
}

/**
 * Folder hygiene review: broken installs (addon ZIPs extracted straight into
 * the AddOns root), stale root copies shadowed by a proper folder, macOS
 * Finder " 2"-duplicates, and leftover unclaimed root files.  Everything the
 * game silently ignores but that confuses users and tooling.
 */
const HygieneDialog: React.FC<HygieneDialogProps> = ({
  strayManifests,
  duplicates,
  unclaimedRootFiles,
  bundledLibs,
  fixes = [],
  onConfirm,
  onCancel,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const broken = strayManifests.filter((s) => !s.folderExists);
  const stale = strayManifests.filter((s) => s.folderExists);

  // Defaults: repair broken installs and remove duplicates/stale copies; leave
  // unclaimed files alone unless the user opts in.
  const [repairSel, setRepairSel] = useState<Set<string>>(() => new Set(broken.map((s) => s.file)));
  const [staleSel, setStaleSel] = useState<Set<string>>(() => new Set(stale.filter((s) => s.rootIsStale).map((s) => s.file)));
  const [dupSel, setDupSel] = useState<Set<string>>(() => new Set(duplicates.map((d) => d.relPath)));
  const [unclaimedSel, setUnclaimedSel] = useState<Set<string>>(() => new Set());
  const [fixSel, setFixSel] = useState<Set<string>>(() => new Set(fixes.filter((f) => f.recommended).map((f) => f.key)));
  const toggleFix = (key: string) => setFixSel((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (key: string) => {
    set((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const toggleRepair = toggle(setRepairSel);
  const toggleStale = toggle(setStaleSel);
  const toggleDup = toggle(setDupSel);
  const toggleUnclaimed = toggle(setUnclaimedSel);

  const totalItems = strayManifests.length + duplicates.length + unclaimedRootFiles.length;
  const totalSelected = repairSel.size + staleSel.size + dupSel.size + unclaimedSel.size + fixSel.size;

  const handleConfirm = () => {
    if (totalSelected === 0) return;
    const removals: string[] = [];
    for (const s of stale) {
      if (staleSel.has(s.file)) removals.push(s.file, ...s.relatedFiles);
    }
    for (const d of duplicates) {
      if (dupSel.has(d.relPath)) removals.push(d.relPath);
    }
    for (const f of unclaimedRootFiles) {
      if (unclaimedSel.has(f)) removals.push(f);
    }
    onConfirm({ repairs: Array.from(repairSel), removals, fixes: Array.from(fixSel) });
  };

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">🩺 Folder Hygiene</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {totalItems === 0 && bundledLibs.length === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              No hygiene problems found — the AddOns folder is clean.
            </div>
          ) : (
            <>
              {broken.length > 0 && (
                <>
                  <div className="cleanup-section-label">
                    Broken installs — extracted into the AddOns root ({broken.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    The game never loads these. Repair moves the manifest and its files
                    into a proper addon folder; updates are then detected normally.
                  </div>
                  <div className="cleanup-items">
                    {broken.map((s) => (
                      <label key={s.file} className="cleanup-item" onClick={() => toggleRepair(s.file)}>
                        <input type="checkbox" checked={repairSel.has(s.file)} readOnly />
                        <span>
                          🔧 <strong>{s.title}</strong> v{s.version || '?'} — {s.file}
                          {s.relatedFiles.length > 0 && ` + ${s.relatedFiles.length} file(s)/folder(s)`}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {stale.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Stale root copies — a proper folder exists ({stale.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Leftover files in the AddOns root shadowed by the installed folder.
                    Moved to Removed/, never deleted.
                  </div>
                  <div className="cleanup-items">
                    {stale.map((s) => (
                      <label key={s.file} className="cleanup-item" onClick={() => toggleStale(s.file)}>
                        <input type="checkbox" checked={staleSel.has(s.file)} readOnly />
                        <span>
                          {s.rootIsStale ? '🗑️' : '⚠️'} {s.file} v{s.version || '?'}
                          {' '}(folder has v{s.folderVersion || '?'})
                          {s.relatedFiles.length > 0 && ` + ${s.relatedFiles.length} file(s)/folder(s)`}
                          {!s.rootIsStale && ' — root copy looks NEWER, check manually'}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {duplicates.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Finder duplicates (" 2" copies) ({duplicates.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Created by macOS when extracting into occupied folders. The original
                    exists next to each copy.
                  </div>
                  <div className="cleanup-items">
                    {duplicates.map((d) => (
                      <label key={d.relPath} className="cleanup-item" onClick={() => toggleDup(d.relPath)}>
                        <input type="checkbox" checked={dupSel.has(d.relPath)} readOnly />
                        <span>{d.isDirectory ? '📁' : '📄'} {d.relPath}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {unclaimedRootFiles.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Unclaimed root files ({unclaimedRootFiles.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Files in the AddOns root that belong to no addon manifest
                    (README, logos, …). Optional to remove.
                  </div>
                  <div className="cleanup-items">
                    {unclaimedRootFiles.map((f) => (
                      <label key={f} className="cleanup-item" onClick={() => toggleUnclaimed(f)}>
                        <input type="checkbox" checked={unclaimedSel.has(f)} readOnly />
                        <span>📄 {f}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {bundledLibs.length > 0 && (() => {
                // Same severity scale as the log: orange = act, yellow = maybe, grey = fine
                const broken = bundledLibs.filter((b) => b.brokenRegistration);
                const outdated = bundledLibs.filter((b) => b.standaloneOutdated && !b.brokenRegistration);
                const differing = bundledLibs.filter((b) => b.versionMismatch && !b.standaloneOutdated && !b.brokenRegistration);
                const same = bundledLibs.filter((b) => !b.versionMismatch);
                const copyText = (e: BundledLibReport['embedded'][number]) =>
                  `${e.parent} ${e.viaFileList ? 'loads from' : 'bundles in'} ${e.relPath} (` +
                  (e.versionUnknown ? 'version unreadable'
                    : `v${e.version || e.addonVersion || '?'}${e.versionFromLibStub ? ' via LibStub' : ''}`) + ')';
                return (
                  <>
                    <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                      Bundled libraries ({bundledLibs.length})
                    </div>
                    <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                      These libraries exist standalone AND inside other addons. YAAM never deletes
                      an embedded copy — whether the host still works without it depends on its code.
                      Where a safe fix exists, it is offered below.
                    </div>
                    <div className="cleanup-items">
                      {broken.map((b) => (
                        <div key={b.name} className="cleanup-item" style={{ color: 'var(--orange)', fontWeight: 700 }}>
                          <span>
                            ⚠️ {b.name} — {b.embedded.filter((e) => e.placeholderVersion).map((e) => e.parent).join(', ')}{' '}
                            registers its own copy with an unfilled version placeholder. The current{' '}
                            {b.name} (v{b.standaloneVersion || '?'}) then cannot initialize its handlers.
                          </span>
                        </div>
                      ))}
                      {outdated.map((b) => (
                        <div key={b.name} className="cleanup-item" style={{ color: 'var(--orange)', fontWeight: 700 }}>
                          <span>
                            ⚠️ {b.name} — your standalone copy (v{b.standaloneVersion || '?'}) is OLDER than the
                            one bundled in {b.embedded.map((e) => `${e.parent} (v${e.version || '?'})`).join(', ')}.
                          </span>
                        </div>
                      ))}
                      {differing.map((b) => (
                        <div key={b.name} className="cleanup-item" style={{ color: 'var(--yellow)' }}>
                          <span>
                            {b.name} — two different copies are live: your standalone v
                            {b.standaloneVersion || '?'} and {b.embedded.map(copyText).join(', ')}.
                            Often harmless; the suspect if {b.name} misbehaves.
                          </span>
                        </div>
                      ))}
                      {same.map((b) => (
                        <div key={b.name} className="cleanup-item" style={{ opacity: 0.65 }}>
                          <span>
                            📚 {b.name} v{b.standaloneVersion || '?'} — also bundled in{' '}
                            {b.embedded.map((e) => e.parent).join(', ')} (same version, nothing to do)
                          </span>
                        </div>
                      ))}
                    </div>
                    {fixes.length > 0 && (
                      <>
                        <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                          Offered fixes ({fixes.length})
                        </div>
                        <div className="cleanup-items">
                          {fixes.map((f) => (
                            <label key={f.key} className="cleanup-item" onClick={() => toggleFix(f.key)}>
                              <input type="checkbox" checked={fixSel.has(f.key)} readOnly />
                              <span>
                                {f.label}
                                <span style={{ display: 'block', fontSize: '0.8rem', opacity: 0.7 }}>{f.detail}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                );
              })()}
            </>
          )}
        </div>
        <div className="settings-actions" style={{ padding: '12px 16px' }}>
          <button className="restore-btn" onClick={onCancel}>Cancel</button>
          <button
            className="restore-btn ie-action-btn"
            onClick={handleConfirm}
            disabled={totalSelected === 0}
          >
            ✓ Apply {totalSelected > 0
              ? `(${[
                  repairSel.size > 0 && `${repairSel.size} repair`,
                  totalSelected - repairSel.size - fixSel.size > 0 && `${totalSelected - repairSel.size - fixSel.size} remove`,
                  fixSel.size > 0 && `${fixSel.size} install`,
                ].filter(Boolean).join(', ')})`
              : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HygieneDialog;
