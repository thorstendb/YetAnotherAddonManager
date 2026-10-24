// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BallastContext, collectBallast, lastCharacterNames, summarizeBallast } from '../../electron/svBallast';
import { parseSavedVars, removeEntries, selectPath } from '../../electron/svParse';
import { cleanupSettingsSelected, previewCleanupSettings, undoCleanupSettings } from '../../electron/settingsManager';
import { listsGameProcess } from '../../electron/gameProcess';

type Lua = string | number | boolean | { [key: string]: Lua };

/** Serialize like the game: CRLF, 4-space indent, "[key] = " before a table on its own line.
 *  Short digit keys become array indices; character ids stay string keys, as the game writes them. */
function eso(name: string, value: { [key: string]: Lua }): string {
  const lines = [`${name} =`, '{'];
  const emit = (obj: { [key: string]: Lua }, ind: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = /^\d{1,9}$/.test(k) ? `[${k}]` : `["${k.replace(/["\\]/g, '\\$&')}"]`;
      if (typeof v === 'object') {
        lines.push(`${ind}${key} = `, `${ind}{`);
        emit(v, ind + '    ');
        lines.push(`${ind}},`);
      } else {
        lines.push(`${ind}${key} = ${typeof v === 'string' ? `"${v.replace(/["\\]/g, '\\$&')}"` : v},`);
      }
    }
  };
  emit(value, '    ');
  lines.push('}');
  return lines.join('\r\n') + '\r\n';
}

const craftStore = eso('CraftStore_Account', {
  Default: { '@Acc': { $AccountWide: { 'EU Megaserver': { storage: {
    '|H0:item:1|h|h': {},
    '|H0:item:2|h|h': { Alhandur: 1 },
    '|H0:item:3|h|h': {},
  } } } } },
});
const debugLog = eso('LibDebugLoggerLog', { 1: { 1: 'a' }, 2: { 1: 'b' }, 3: { 1: 'c' } })
  + eso('LibDebugLoggerSettings', { minLogLevel: 'I' });
const perCharacter = eso('Some_SV', {
  Default: { '@Acc': {
    $AccountWide: { 'EU Megaserver': { x: 1 }, 'NA Megaserver': { x: 2 } },
    '8798292051451459': { $LastCharacterName: 'Alhandur', x: 1 },
    '8798292000000001': { $LastCharacterName: 'Ghost', x: 1 },
    Ghost: { legacy: true },
  } },
});
const ctx: BallastContext = { playedWorlds: ['EU Megaserver'], unknownCharacters: ['Ghost'] };
const b = (s: string) => Buffer.from(s, 'utf-8');

describe('ballast rules', () => {
  it('finds CraftStore storage entries no character owns anymore — preselected', () => {
    const [hit] = collectBallast('CraftStoreFixedAndImproved.lua', b(craftStore), ctx);
    expect(hit.findingId).toBe('craftstore-empty-storage');
    expect(hit.defaultSelected).toBe(true);
    expect(hit.nodes.map((n) => n.key)).toEqual(['|H0:item:1|h|h', '|H0:item:3|h|h']);
    const kept = selectPath(parseSavedVars(removeEntries(b(craftStore), hit.nodes).output), ['CraftStore_Account', '*', '*', '*', '*', 'storage', '*']);
    expect(kept.map((n) => n.key)).toEqual(['|H0:item:2|h|h']);
  });

  it('finds old LibDebugLogger entries but keeps its settings', () => {
    const [hit] = collectBallast('LibDebugLogger.lua', b(debugLog), ctx);
    expect(hit.nodes).toHaveLength(3);
    const out = removeEntries(b(debugLog), hit.nodes).output.toString();
    expect(out).toContain('["minLogLevel"] = "I"');
  });

  it('offers other servers and unknown characters, never preselected', () => {
    const hits = collectBallast('Some_SV.lua', b(perCharacter), ctx);
    expect(hits.map((h) => [h.findingId, h.defaultSelected, h.nodes.map((n) => n.key)])).toEqual([
      ['world:NA Megaserver', false, ['NA Megaserver']],
      ['character:Ghost', false, ['8798292000000001', 'Ghost']],
    ]);
  });

  it('judges nothing per server or character without AddOnSettings sections', () => {
    expect(collectBallast('Some_SV.lua', b(perCharacter), { playedWorlds: [], unknownCharacters: [] })).toEqual([]);
  });

  it('never touches the game\'s own files or Master Merchant sales data', () => {
    expect(collectBallast('ZO_Ingame.lua', b(perCharacter), ctx)).toEqual([]);
    expect(collectBallast('GS05Data.lua', b(perCharacter), ctx)).toEqual([]);
  });

  it('merges findings across files and sizes them by the bytes they cut', () => {
    const files = ['A.lua', 'B.lua'].map((file) => ({ file, buf: b(perCharacter), hits: collectBallast(file, b(perCharacter), ctx) }));
    const world = summarizeBallast(files).find((f) => f.id === 'world:NA Megaserver')!;
    expect(world.files).toEqual(['A.lua', 'B.lua']);
    expect(world.count).toBe(2);
    const single = removeEntries(b(perCharacter), files[0].hits[0].nodes).removedBytes;
    expect(world.bytes).toBe(2 * single);
  });

  it('reads character names a file records', () => {
    expect(lastCharacterNames(b(perCharacter)).sort()).toEqual(['Alhandur', 'Ghost']);
  });
});

describe('settings cleanup with ballast (preview → apply → undo)', () => {
  let tmpRoot: string;
  let addonsPath: string;
  let svDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-ballast-'));
    addonsPath = path.join(tmpRoot, 'live', 'AddOns');
    svDir = path.join(tmpRoot, 'live', 'SavedVariables');
    fs.mkdirSync(addonsPath, { recursive: true });
    fs.mkdirSync(svDir, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'live', 'AddOnSettings.txt'), '#Version 101051\r\n#Default\r\n#EU Megaserver-Alhandur\r\nCraftStoreFixedAndImproved 1\r\n');
    fs.writeFileSync(path.join(svDir, 'CraftStoreFixedAndImproved.lua'), craftStore);
    fs.writeFileSync(path.join(svDir, 'LibDebugLogger.lua'), debugLog);
    fs.writeFileSync(path.join(svDir, 'SynergyCooldown.lua'), eso('SynergyCooldown_SV', { a: 1 }));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const installed = ['CraftStoreFixedAndImproved', 'LibDebugLogger', 'Synergy'];

  it('matches SavedVariables to addons by exact name', () => {
    // A shorter installed name ("Synergy") must not hide an orphan
    expect(previewCleanupSettings(addonsPath, installed).orphanedSavedVars).toEqual(['SynergyCooldown.lua']);
  });

  it('lists ballast, trims only the selected finding and undoes it byte for byte', () => {
    const preview = previewCleanupSettings(addonsPath, installed);
    expect(preview.ballast.map((f) => [f.id, f.count, f.defaultSelected]).sort()).toEqual([
      ['craftstore-empty-storage', 2, true],
      ['libdebuglogger-log', 3, true],
    ]);

    const result = cleanupSettingsSelected(addonsPath, installed, [], [], ['craftstore-empty-storage']);
    expect(result.trimmedSavedVars.map((t) => t.file)).toEqual(['CraftStoreFixedAndImproved.lua']);
    const trimmed = fs.readFileSync(path.join(svDir, 'CraftStoreFixedAndImproved.lua'), 'utf-8');
    expect(trimmed).not.toContain('|H0:item:1|h|h');
    expect(trimmed).toContain('|H0:item:2|h|h');
    expect(fs.readFileSync(path.join(svDir, 'LibDebugLogger.lua'), 'utf-8')).toBe(debugLog);
    expect(fs.readFileSync(path.join(result.svBackupDir, 'CraftStoreFixedAndImproved.lua'), 'utf-8')).toBe(craftStore);

    const undo = undoCleanupSettings(addonsPath, result.backupPath, result.svBackupDir);
    expect(undo.restoredSavedVars).toEqual(['CraftStoreFixedAndImproved.lua']);
    expect(fs.readFileSync(path.join(svDir, 'CraftStoreFixedAndImproved.lua'), 'utf-8')).toBe(craftStore);
  });

  it('skips files it cannot parse instead of failing', () => {
    fs.writeFileSync(path.join(svDir, 'LibDebugLogger.lua'), 'LibDebugLoggerLog = {["broken"');
    const preview = previewCleanupSettings(addonsPath, installed);
    expect(preview.ballast.map((f) => f.id)).toEqual(['craftstore-empty-storage']);
  });
});

describe('listsGameProcess', () => {
  it('recognises the client on every platform, nothing else', () => {
    expect(listsGameProcess(['"eso64.exe"'])).toBe(true);
    expect(listsGameProcess(['/Applications/The Elder Scrolls Online.app/Contents/MacOS/The Elder Scrolls Online'])).toBe(true);
    expect(listsGameProcess(['Z:\\ESO\\game\\client\\eso64.exe'])).toBe(true);
    expect(listsGameProcess(['"esotool.exe"', 'Code.exe', 'yaam'])).toBe(false);
  });
});
