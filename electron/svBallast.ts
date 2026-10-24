// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Superfluous data inside the SavedVariables of INSTALLED addons.
 *
 * The game parses every SavedVariables file of every loaded addon at each
 * login and /reloadui, so dead data costs load time on every character.  The
 * orphaned-file cleanup only removes files of uninstalled addons; this finds
 * ballast inside files that are still in use.
 *
 * Only data no addon reads again is offered, and only the cases where that is
 * certain are preselected.  Never touched: the game's own ZO_* files, and
 * Master Merchant's sales databases (GS00Data…GS17Data) — their size is
 * governed by Master Merchant's own history settings.
 */
import { SvBallastFinding } from './shared/types';
import { SvNode, parseSavedVars, removalRange, selectPath, walkSavedVars } from './svParse';

export interface BallastContext {
  /** Worlds with a character section in AddOnSettings.txt, e.g. "EU Megaserver" */
  playedWorlds: string[];
  /** Names found as $LastCharacterName in SavedVariables that have no
   *  section in AddOnSettings.txt — deleted, renamed, or never configured */
  unknownCharacters: string[];
}

export interface RuleHit {
  findingId: string;
  label: string;
  detail: string;
  defaultSelected: boolean;
  nodes: SvNode[];
}

interface BallastRule {
  /** File the rule is limited to (with .lua); every file when omitted */
  file?: string;
  /** Cheap byte test: a file containing none of these is not even parsed */
  markers: (ctx: BallastContext) => string[];
  collect: (roots: SvNode[], ctx: BallastContext) => RuleHit[];
}

/** Server names as they appear in AddOnSettings.txt sections and SavedVariables */
export const KNOWN_WORLDS = ['NA Megaserver', 'EU Megaserver', 'PTS'];
const EXCLUDED_FILE = /^(ZO_.*|GS\d\dData)\.lua$/i;

const unplayedWorlds = (ctx: BallastContext) =>
  ctx.playedWorlds.length === 0 ? [] : KNOWN_WORLDS.filter((w) => !ctx.playedWorlds.includes(w));

const RULES: BallastRule[] = [
  {
    // CraftStore records every item a character ever owned and only clears the
    // counts, never the entry — tens of thousands of empty tables after a while
    file: 'CraftStoreFixedAndImproved.lua',
    markers: () => ['"storage"'],
    collect: (roots) => [{
      findingId: 'craftstore-empty-storage',
      label: 'CraftStore: empty inventory entries',
      detail: 'Items none of your characters owns anymore. CraftStore never removes them and re-adds an entry when an item shows up again.',
      defaultSelected: true,
      nodes: selectPath(roots, ['CraftStore_Account', '*', '*', '*', '*', 'storage', '*'])
        .filter((n) => n.children !== undefined && n.children.length === 0),
    }],
  },
  {
    file: 'LibDebugLogger.lua',
    markers: () => ['LibDebugLoggerLog'],
    collect: (roots) => [{
      findingId: 'libdebuglogger-log',
      label: 'LibDebugLogger: log entries from earlier sessions',
      detail: 'Only needed to send a log to an addon author. LibDebugLogger starts a new log right away.',
      defaultSelected: true,
      nodes: selectPath(roots, ['LibDebugLoggerLog', '*']),
    }],
  },
  {
    // ZO_SavedVars nests data under the world name for many addons
    markers: (ctx) => unplayedWorlds(ctx).map((w) => `"${w}"`),
    collect: (roots, ctx) => {
      const worlds = unplayedWorlds(ctx);
      const byWorld = new Map<string, SvNode[]>();
      walkSavedVars(roots, (node) => {
        if (!node.children || !worlds.includes(node.key) || !node.keyIsString) return;
        byWorld.set(node.key, [...(byWorld.get(node.key) ?? []), node]);
        return true;
      });
      return [...byWorld].map(([world, nodes]) => ({
        findingId: `world:${world}`,
        label: `Data for ${world}`,
        detail: 'No character on this server has a section in AddOnSettings.txt. Keep it if you still play there.',
        defaultSelected: false,
        nodes,
      }));
    },
  },
  {
    // Per-character branches: ZO_SavedVars stores the name next to the
    // character id; older addons key the branch by the name directly below
    // the account ("@Name") level
    markers: (ctx) => ctx.unknownCharacters.map((n) => `"${n}"`),
    collect: (roots, ctx) => {
      const byName = new Map<string, SvNode[]>();
      walkSavedVars(roots, (node, ancestors) => {
        if (!node.children) return;
        const last = node.children.find((c) => c.key === '$LastCharacterName' && c.value?.startsWith('"'));
        const name = last ? last.value!.slice(1, -1)
          : ancestors[ancestors.length - 1]?.key.startsWith('@') ? node.key : undefined;
        if (name === undefined || !ctx.unknownCharacters.includes(name)) return;
        byName.set(name, [...(byName.get(name) ?? []), node]);
        return true;
      });
      return [...byName].map(([name, nodes]) => ({
        findingId: `character:${name}`,
        label: `Character "${name}"`,
        detail: 'Has no section in AddOnSettings.txt. Select it only if the character was deleted or renamed — otherwise its addon settings are reset.',
        defaultSelected: false,
        nodes,
      }));
    },
  },
];

const LAST_CHARACTER_NAME = /\["\$LastCharacterName"\]\s*=\s*"([^"]*)"/g;

/** Character names a SavedVariables file records ($LastCharacterName) */
export function lastCharacterNames(buf: Uint8Array): string[] {
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf-8');
  return [...new Set([...text.matchAll(LAST_CHARACTER_NAME)].map((m) => m[1]))];
}

/** Files no rule ever touches */
export function isBallastExcluded(file: string): boolean {
  return EXCLUDED_FILE.test(file);
}

/** Ballast in one file, each hit with the entries it would remove */
export function collectBallast(file: string, buf: Uint8Array, ctx: BallastContext): RuleHit[] {
  if (isBallastExcluded(file)) return [];
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const rules = RULES.filter((r) => (!r.file || r.file.toLowerCase() === file.toLowerCase())
    && r.markers(ctx).some((m) => view.includes(m)));
  if (rules.length === 0) return [];
  const roots = parseSavedVars(buf);
  return rules.flatMap((r) => r.collect(roots, ctx)).filter((h) => h.nodes.length > 0);
}

/** Merge per-file hits into findings, sized by the bytes each would cut */
export function summarizeBallast(perFile: { file: string; buf: Uint8Array; hits: RuleHit[] }[]): SvBallastFinding[] {
  const findings = new Map<string, SvBallastFinding>();
  for (const { file, buf, hits } of perFile) {
    for (const hit of hits) {
      const f = findings.get(hit.findingId) ?? {
        id: hit.findingId, label: hit.label, detail: hit.detail, files: [], count: 0, bytes: 0,
        defaultSelected: hit.defaultSelected,
      };
      f.files.push(file);
      f.count += hit.nodes.length;
      for (const n of hit.nodes) {
        const [from, to] = removalRange(buf, n);
        f.bytes += to - from;
      }
      findings.set(hit.findingId, f);
    }
  }
  return [...findings.values()].sort((a, b) => b.bytes - a.bytes);
}
