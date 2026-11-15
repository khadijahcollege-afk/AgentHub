import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, skillsForPrompt, augmentWithSkills } from '../lib/skills.js';

test('skills: discovers installed files, deduplicates, and prefers project instructions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-skills-'));
  const project = path.join(home, 'project');
  try {
    for (const dir of ['.claude/skills/example', '.agents/skills/example', 'project/.agents/skills/example']) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
      fs.writeFileSync(path.join(home, dir, 'SKILL.md'), '---\nname: Example\ndescription: Helpful instructions\n---\nUse the example marker.');
    }
    const list = discoverSkills(project, home);
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'Proyek');
    assert.equal(list[0].description, 'Helpful instructions');
    assert.equal(skillsForPrompt('/skill example do this', list).length, 1);
    assert.equal(skillsForPrompt('unrelated task', list).length, 0);
    assert.match(augmentWithSkills('/skill example', project), /Use the example marker/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
