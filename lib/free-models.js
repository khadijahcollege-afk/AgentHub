// Parse the verbose CLI catalog; only explicit zero-priced tool models qualify.
export function parseFreeModels(output) {
  const models = [];
  for (const block of String(output).split(/^opencode\//m).slice(1)) {
    const start = block.indexOf('{');
    if (start < 0) continue;
    try {
      const model = JSON.parse(block.slice(start).trim());
      if (model.providerID !== 'opencode' || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(model.id)) continue;
      if (model.status !== 'active' || model.capabilities?.toolcall !== true) continue;
      if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
      if (Object.values(model.cost.cache || {}).some(cost => cost !== 0)) continue;
      if (!models.some(item => item.id === model.id)) models.push({ id: model.id, name: model.name || model.id });
    } catch { /* ignore incomplete catalog entries */ }
  }
  return models;
}

export function freeModelEngine(model) {
  return {
    id: model.id === 'big-pickle' ? 'opencode-free' : `opencode-free-${model.id}`,
    label: `OpenCode · ${model.name} (gratis)`, type: 'cli', cmd: 'opencode',
    args: ['run', '--pure', '--model', `opencode/${model.id}`, '--auto'],
    stdin: true, optIn: true, model: `opencode/${model.id}`,
  };
}
