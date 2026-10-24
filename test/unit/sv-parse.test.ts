// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { parseSavedVars, removeEntries, selectPath, SvParseError } from '../../electron/svParse';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const buf = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf-8') : s);

/** The layout the game writes: 4-space indent, CRLF, "key = " before a table */
const ESO = crlf([
  'Test_SV =',
  '{',
  '    ["Default"] = ',
  '    {',
  '        ["@Acc"] = ',
  '        {',
  '            ["$AccountWide"] = ',
  '            {',
  '                ["name"] = "Quote \\" and \\\\ backslash",',
  '                [1] = 12,',
  '                [2] = -0.5,',
  '                ["flag"] = true,',
  '                ["empty"] = ',
  '                {',
  '                },',
  '            },',
  '        },',
  '    },',
  '}',
]);

describe('parseSavedVars', () => {
  it('reads the game layout: keys, scalars, nested tables', () => {
    const [root] = parseSavedVars(buf(ESO));
    expect(root.key).toBe('Test_SV');
    const entries = selectPath([root], ['Test_SV', 'Default', '@Acc', '$AccountWide', '*']);
    expect(entries.map((e) => [e.key, e.keyIsString, e.value])).toEqual([
      ['name', true, '"Quote \\" and \\\\ backslash"'],
      ['1', false, '12'],
      ['2', false, '-0.5'],
      ['flag', true, 'true'],
      ['empty', true, undefined],
    ]);
    expect(entries[4].children).toEqual([]);
  });

  it('reads compact one-line files, identifier keys and positional values', () => {
    const roots = parseSavedVars(buf('A={["a"]=1,["b"]={["c"]=0.0400000000},[3]="s",}\r\nB={x=1,"pos",{1,2};y=1.#INF}'));
    expect(roots.map((r) => r.key)).toEqual(['A', 'B']);
    expect(roots[0].children!.map((c) => c.key)).toEqual(['a', 'b', '3']);
    expect(roots[1].children!.map((c) => [c.key, c.keyIsString])).toEqual([['x', true], ['1', false], ['2', false], ['y', true]]);
    expect(roots[1].children![3].value).toBe('1.#INF');
  });

  it('unescapes string keys', () => {
    const [root] = parseSavedVars(buf('T={["a\\"b"]=1,["c\\\\d"]=2,["e\\110"]=3}'));
    expect(root.children!.map((c) => c.key)).toEqual(['a"b', 'c\\d', 'en']);
  });

  it('rejects what is not a table file', () => {
    expect(() => parseSavedVars(buf('T={["a"]=1'))).toThrow(SvParseError);
    expect(() => parseSavedVars(buf('T={["a"]=1 ["b"]=2}'))).toThrow(SvParseError);
    expect(() => parseSavedVars(buf('-- comment\r\nT={}'))).toThrow(SvParseError);
    expect(() => parseSavedVars(buf('T={["a"]="open\r\n"}'))).toThrow(SvParseError);
  });
});

describe('removeEntries', () => {
  it('cuts whole lines in the game layout and keeps every other byte', () => {
    const input = buf(ESO);
    const [empty] = selectPath(parseSavedVars(input), ['Test_SV', 'Default', '@Acc', '$AccountWide', 'empty']);
    const { output, removedBytes, removedEntries } = removeEntries(input, [empty]);
    const expected = ESO.replace('                ["empty"] = \r\n                {\r\n                },\r\n', '');
    expect(output.toString('utf-8')).toBe(expected);
    expect(removedBytes).toBe(input.length - Buffer.byteLength(expected));
    expect(removedEntries).toBe(1);
  });

  it('leaves the file untouched when nothing is removed', () => {
    expect(removeEntries(buf(ESO), []).output.equals(buf(ESO))).toBe(true);
  });

  it('cuts entry and separator in compact files', () => {
    const input = buf('Y={["a"]=1,["b"]=2}');
    const [a, b] = parseSavedVars(input)[0].children!;
    expect(removeEntries(input, [b]).output.toString()).toBe('Y={["a"]=1,}');
    expect(removeEntries(input, [a]).output.toString()).toBe('Y={["b"]=2}');
    expect(removeEntries(input, [a, b]).output.toString()).toBe('Y={}');
  });

  it('skips entries inside an entry that is removed anyway', () => {
    const input = buf(ESO);
    const roots = parseSavedVars(input);
    const outer = selectPath(roots, ['Test_SV', 'Default', '@Acc']);
    const inner = selectPath(roots, ['Test_SV', 'Default', '@Acc', '$AccountWide', '*']);
    const { output, removedEntries } = removeEntries(input, [...inner, ...outer]);
    expect(removedEntries).toBe(1);
    expect(output.toString()).toBe(crlf(['Test_SV =', '{', '    ["Default"] = ', '    {', '    },', '}']));
  });

  it('preserves bytes that are not valid UTF-8', () => {
    const input = Buffer.concat([buf('T={["k"]="café '), Buffer.from([0xff, 0xfe]), buf('",["drop"]=1}')]);
    const [, drop] = parseSavedVars(input)[0].children!;
    const { output } = removeEntries(input, [drop]);
    expect(output.equals(Buffer.concat([buf('T={["k"]="café '), Buffer.from([0xff, 0xfe]), buf('",}')]))).toBe(true);
  });
});
