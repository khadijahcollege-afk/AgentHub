import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function discoverSkills(cwd, home = os.homedir()) {
  const roots = [['OpenCode', '.config/opencode/skills'], ['OpenCode', '.config/opencode/skill'], ['Claude', '.claude/skills'], ['Codex', '.codex/skills'], ['Agents', '.agents/skills']].map(([source, dir]) => [source, path.join(home, dir)]);
  if (cwd && path.isAbsolute(cwd)) for (const dir of ['.agents/skills', '.claude/skills', '.opencode/skills']) roots.push(['Proyek', path.join(cwd, dir)]);
  const found = new Map();
  for (const [source, root] of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 300)) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      try {
        if (fs.statSync(file).size > 200000) continue;
        const text = fs.readFileSync(file, 'utf8');
        const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const name = front?.[1].match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '') || entry.name;
        const description = front?.[1].match(/^description:\s*([\s\S]*?)(?=\n[\w-]+:|$)/m)?.[1].replace(/^[>|]\s*/, '').replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim() || '';
        const id = entry.name.toLowerCase();
        if (!found.has(id) || source === 'Proyek') found.set(id, { id, name, description, source, path: file });
      } catch { /* missing or unreadable skill */ }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsForPrompt(prompt, skills) {
  const text = String(prompt).toLowerCase();
  return skills.filter(skill => {
    if (text.includes('$' + skill.id) || text.includes('/skill ' + skill.id) || text.includes(skill.id)) return true;
    const terms = skill.id.split(/[-_]/).filter(word => word.length > 2);
    const words = new Set(text.split(/[^a-z0-9]+/));
    return terms.length > 0 && terms.every(word => words.has(word));
  }).slice(0, 4);
}

export function augmentWithSkills(prompt, cwd) {
  const skills = discoverSkills(cwd);
  if (!skills.length) return prompt;
  const catalog = skills.map(s => `- ${s.id}: ${s.description.slice(0, 220)} (file: ${s.path})`).join('\n');
  const instructions = skillsForPrompt(prompt, skills).map(s => {
    try { return `<installed_skill name=${JSON.stringify(s.id)} path=${JSON.stringify(s.path)}>\n${fs.readFileSync(s.path, 'utf8').slice(0, 20000)}\n</installed_skill>`; } catch { return ''; }
  }).join('\n');
  return `${prompt}\n\n<available_local_skills>\nInstalled skills available for this task. Use relevant skills; user instructions take precedence. If file tools are available, read the listed SKILL.md when relevant and resolve references relative to its directory. Do not claim tool capabilities you do not have.\n${catalog}\n</available_local_skills>\n${instructions}`;
}
