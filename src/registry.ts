/**
 * @module dsh-agent-skill-lifecycle/registry
 * Skill-directory scanning: read the `name` field from SKILL.md frontmatter
 * across the DSH skill roots. Strictly read-only — skill files are never
 * written by this module.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Candidate skill roots in precedence order: user scope, project scope, then
 * the machine-global DSH root. A name present in several roots is counted once
 * (earliest root wins).
 * @param cwd - Session workspace root, when known.
 * @param env - Environment source (injectable for tests).
 * @returns Existing-or-not root paths in precedence order.
 */
export function skillRoots(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir()
  const roots = [join(home, '.agents', 'skills')]
  if (typeof cwd === 'string' && cwd !== '') roots.push(join(cwd, '.agents', 'skills'))
  // 第三来源（2026-09-26 修复漏扫）：DSH_HOME/skills —— 本机全局技能，
  // 见技能 skill-maintenance §1「目录布局（三个来源）」。
  roots.push(join(env['DSH_HOME'] ?? join(home, '.dsh'), 'skills'))
  return roots
}

/**
 * Extract the skill name from a SKILL.md body.
 * @param content - File content.
 * @returns The frontmatter `name` (quotes stripped), or `null` when absent.
 */
export function parseSkillName(content: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  const block = end === -1 ? content.slice(0, 4000) : content.slice(0, end)
  const match = /^name:[ \t]*(.+)$/m.exec(block)
  const raw = match?.[1]?.trim()
  if (raw === undefined || raw === '') return null
  return raw.replace(/^['"]|['"]$/g, '')
}

/**
 * Scan one root directory for skills.
 * @param root - Directory holding `<skill-name>/SKILL.md` entries.
 * @returns Skill names found; unreadable entries are skipped silently.
 */
export function scanRoot(root: string): string[] {
  const names: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (e: unknown) {
    void e
    return names
  }
  for (const dir of entries) {
    const file = join(root, dir, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const parsed = parseSkillName(readFileSync(file, 'utf8'))
      // Frontmatter name wins; fall back to the directory name so a skill
      // without frontmatter is still tracked rather than silently dropped.
      names.push(parsed ?? dir)
    } catch (e: unknown) {
      void e
      continue
    }
  }
  return names
}

/**
 * Scan every root, de-duplicating names (first root wins).
 * @param roots - Roots from {@link skillRoots}.
 * @returns Unique skill names.
 */
export function scanSkillNames(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const root of roots) {
    for (const name of scanRoot(root)) seen.add(name)
  }
  return [...seen]
}
