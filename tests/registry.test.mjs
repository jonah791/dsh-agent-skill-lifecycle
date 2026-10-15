/**
 * registry 扫描层离线单测（技能目录 → 技能名）
 * 运行：先 build（tsc）再 node --test tests/registry.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillName, scanRoot, scanSkillNames, skillRoots } from '../lib/registry.js'

describe('parseSkillName · frontmatter', () => {
  test('标准 frontmatter → name', () => {
    assert.equal(parseSkillName('---\nname: my-skill\ndescription: x\n---\n\n# T\n'), 'my-skill')
  })

  test('带引号 → 去掉引号', () => {
    assert.equal(parseSkillName('---\nname: "quoted-skill"\n---\n'), 'quoted-skill')
    assert.equal(parseSkillName("---\nname: 'single'\n---\n"), 'single')
  })

  test('无 frontmatter → null', () => {
    assert.equal(parseSkillName('# 只有正文\n'), null)
  })

  test('frontmatter 里没有 name → null', () => {
    assert.equal(parseSkillName('---\ndescription: x\n---\n'), null)
  })

  test('正文里的 name: 不算（只看 frontmatter 块）', () => {
    const content = '---\ndescription: x\n---\n\nname: body-only\n'
    assert.equal(parseSkillName(content), null)
  })
})

describe('scanRoot · 目录扫描', () => {
  test('真实临时目录：取 SKILL.md 的 name，忽略无 SKILL.md 的目录', () => {
    const root = join(tmpdir(), `skill-root-${Date.now()}`)
    mkdirSync(join(root, 'alpha'), { recursive: true })
    mkdirSync(join(root, 'beta'), { recursive: true })
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha-skill\n---\n')
    writeFileSync(join(root, 'beta', 'SKILL.md'), '---\nname: beta-skill\n---\n')
    writeFileSync(join(root, 'not-a-skill', 'README.md'), 'x')
    const names = scanRoot(root).sort()
    assert.deepEqual(names, ['alpha-skill', 'beta-skill'])
    rmSync(root, { recursive: true, force: true })
  })

  test('无 frontmatter 的技能用目录名兜底（不被静默丢弃）', () => {
    const root = join(tmpdir(), `skill-root-fb-${Date.now()}`)
    mkdirSync(join(root, 'raw-skill'), { recursive: true })
    writeFileSync(join(root, 'raw-skill', 'SKILL.md'), '# 无 frontmatter\n')
    assert.deepEqual(scanRoot(root), ['raw-skill'])
    rmSync(root, { recursive: true, force: true })
  })

  test('不存在的根 → 空数组且不抛', () => {
    let names = null
    assert.doesNotThrow(() => {
      names = scanRoot(join(tmpdir(), 'definitely-missing-' + Date.now()))
    })
    assert.deepEqual(names, [])
  })
})

describe('scanSkillNames · 多根去重', () => {
  test('同名技能只计一次（先出现的根胜出）', () => {
    const a = join(tmpdir(), `dup-a-${Date.now()}`)
    const b = join(tmpdir(), `dup-b-${Date.now()}`)
    for (const root of [a, b]) {
      mkdirSync(join(root, 'same'), { recursive: true })
      writeFileSync(join(root, 'same', 'SKILL.md'), '---\nname: same-skill\n---\n')
    }
    assert.deepEqual(scanSkillNames([a, b]), ['same-skill'])
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
})

describe('skillRoots · 根解析', () => {
  test('user → project → DSH 三根齐备（cwd 提供时）', () => {
    const roots = skillRoots('/work/proj', { USERPROFILE: '/home/u', DSH_HOME: '/home/u/.dsh' })
    assert.equal(roots.length, 3)
    assert.match(roots[0], /[/\\]\.agents[/\\]skills$/)
    assert.match(roots[1], /proj[/\\]\.agents[/\\]skills$/)
    assert.match(roots[2], /[/\\]skills$/)
  })

  test('无 cwd → user + DSH 两根（project 根不出现）', () => {
    const roots = skillRoots(undefined, { USERPROFILE: '/home/u' })
    assert.equal(roots.length, 2)
    assert.match(roots[0], /[/\\]\.agents[/\\]skills$/)
    assert.match(roots[1], /\.dsh[/\\]skills$/)
  })

  test('DSH_HOME 覆盖生效（第三根跟随）', () => {
    const roots = skillRoots(undefined, { USERPROFILE: '/home/u', DSH_HOME: '/custom/dsh' })
    assert.match(roots[1], /custom[/\\]dsh[/\\]skills$/)
  })
})
