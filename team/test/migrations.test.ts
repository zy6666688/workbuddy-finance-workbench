import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

test('each versioned migration records its own version for safe repeat upgrades', async () => {
  for (const name of (await readdir('migrations')).filter(name => /^\d+_.+\.sql$/.test(name))) {
    const version = Number(name.split('_')[0])
    const source = await readFile(path.join('migrations', name), 'utf8')
    assert.match(source, new RegExp(`INSERT\\s+INTO\\s+schema_migrations\\s*\\(\\s*version\\s*\\)\\s*VALUES\\s*\\(\\s*${version}\\s*\\)`, 'i'), name)
  }
})
