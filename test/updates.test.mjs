/**
 * Checks for the install-spec / update-verdict logic.
 *
 * These are the rules that decide whether a row says "up to date" or "update",
 * and they are pure, so they can be pinned without a profile or a network.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLockedCommit } from '../lib/inventory.mjs'
import { compareVersions, interpretGithub, interpretNpm, parseSpec, planCheck, updateSpec } from '../lib/updates.mjs'

const rows = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  rows.push({ name, ok, actual, expected })
}

// ---- parseSpec -------------------------------------------------------------

check('bare github spec is github, not npm',
  parseSpec('github:purakkon/dsh-desk-stickers'),
  { kind: 'github', owner: 'purakkon', repo: 'dsh-desk-stickers', ref: '', spec: 'github:purakkon/dsh-desk-stickers' })

check('pinned github spec keeps its ref',
  parseSpec('github:purakkon/dsh-desk-stickers#89ea414')?.ref,
  '89ea414')

check('git+https github url is github',
  parseSpec('git+https://github.com/a/b.git')?.kind,
  'github')

check('github web url with ref is github',
  parseSpec('https://github.com/a/b#main')?.ref,
  'main')

check('npm range stays npm', parseSpec('^1.2.3')?.kind, 'npm')
check('link stays link', parseSpec('link:C:/x/y')?.kind, 'link')
check('workspace stays local', parseSpec('workspace:*')?.kind, 'local')

// ---- planCheck -------------------------------------------------------------

check('github plan points at the commits api',
  planCheck({ name: 'p', source: parseSpec('github:o/r') }).kind,
  'github')
check('link has nothing to check',
  planCheck({ name: 'p', source: parseSpec('link:C:/x') }).kind,
  'none')

// ---- verdicts --------------------------------------------------------------

const head = [{ sha: 'b'.repeat(40), commit: { committer: { date: '2026-11-15T10:00:00Z' } } }]

check('same commit means current',
  interpretGithub({ source: { kind: 'github', ref: 'b'.repeat(40) } }, head).status,
  'current')

check('moved branch means update',
  interpretGithub({ source: { kind: 'github', ref: 'a'.repeat(40) } }, head).status,
  'update')

check('no ref cannot be judged',
  interpretGithub({ source: { kind: 'github', ref: '' } }, head).status,
  'unknown')

check('empty commits answer is unknown',
  interpretGithub({ source: { kind: 'github', ref: 'a'.repeat(40) } }, []).status,
  'unknown')

check('npm update verdict', interpretNpm({ version: '1.0.0' }, { version: '1.1.0' }).status, 'update')
check('npm current verdict', interpretNpm({ version: '1.1.0' }, { version: '1.1.0' }).status, 'current')

// ---- updateSpec ------------------------------------------------------------

const githubPlugin = { name: 'p', source: { kind: 'github', owner: 'o', repo: 'r', ref: 'a'.repeat(40) } }
check('github update pins the new commit',
  updateSpec(githubPlugin, { status: 'update', latest: 'c'.repeat(40) }),
  `github:o/r#${'c'.repeat(40)}`)

check('npm update uses a caret range',
  updateSpec({ name: 'p', source: { kind: 'npm' } }, { status: 'update', latest: '1.2.3' }),
  'p@^1.2.3')

check('no verdict means no spec', updateSpec(githubPlugin, null), null)

// ---- readLockedCommit ------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'lock-'))
mkdirSync(join(profile), { recursive: true })
writeFileSync(join(profile, 'pnpm-lock.yaml'), [
  'lockfileVersion: \'9.0\'',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      dsh-desk-stickers:',
  '        specifier: github:purakkon/dsh-desk-stickers',
  '        version: https://codeload.github.com/purakkon/dsh-desk-stickers/tar.gz/0123456789abcdef0123456789abcdef01234567',
  '      dsh-other:',
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '',
].join('\r\n'), 'utf8')

check('lockfile commit is read through CRLF',
  readLockedCommit(profile, 'dsh-desk-stickers'),
  '0123456789abcdef0123456789abcdef01234567')

check('unknown package reads as nothing', readLockedCommit(profile, 'nope'), '')
check('missing lockfile reads as nothing', readLockedCommit(join(profile, 'nope'), 'dsh-desk-stickers'), '')

// ---- compareVersions -------------------------------------------------------

check('0.9.9 < 0.10.0', compareVersions('0.9.9', '0.10.0'), -1)
check('equal versions', compareVersions('1.0.0', '1.0.0'), 0)
check('prerelease is lower', compareVersions('1.0.0-beta', '1.0.0'), -1)

const failed = rows.filter(row => !row.ok)
for (const row of rows) {
  console.log((row.ok ? 'PASS  ' : 'FAIL  ') + row.name)
  if (!row.ok) console.log('      got ' + JSON.stringify(row.actual) + ' want ' + JSON.stringify(row.expected))
}
console.log('\n' + (rows.length - failed.length) + '/' + rows.length + ' passed')
if (failed.length > 0) process.exitCode = 1
