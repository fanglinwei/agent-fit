import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));

test('marketplace resolves the plugin and its complete existing Skill', async () => {
  const marketplace = await json('.agents/plugins/marketplace.json');
  const entry = marketplace.plugins[0];
  const pluginRoot = path.resolve(root, entry.source.path);
  assert.equal(pluginRoot, path.resolve(root));
  const manifest = await json('.codex-plugin/plugin.json');
  assert.equal(entry.name, manifest.name);
  assert.equal(manifest.version, (await json('package.json')).version);
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.policy.installation, 'AVAILABLE');
  const skills = path.resolve(pluginRoot, manifest.skills);
  assert.ok(skills.startsWith(pluginRoot + path.sep));
  const skillRoot = path.join(skills, 'agent-fit');
  assert.ok((await stat(path.join(skillRoot, 'SKILL.md'))).isFile());
  // Resolve every local Markdown link as it will be resolved in the installed plugin.
  async function checkLinks(directory) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, file.name);
      if (file.isDirectory()) await checkLinks(target);
      else if (file.name.endsWith('.md')) {
        const source = await readFile(target, 'utf8');
        for (const [, link] of source.matchAll(/\]\(([^)]+)\)/g)) {
          if (/^(?:https?:|#)/.test(link)) continue;
          const resolved = path.resolve(directory, link.split('#')[0]);
          assert.ok(resolved.startsWith(pluginRoot + path.sep), `${target}: ${link} escapes plugin`);
          await stat(resolved);
        }
      }
    }
  }
  await checkLinks(skillRoot);
});
