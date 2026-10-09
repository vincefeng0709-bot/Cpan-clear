// Offline rendering-logic checks; no browser or network required.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || 'reports/latest.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', innerHTML: '', textContent: '', listeners: {}, children: [],
    addEventListener(name, fn) { this.listeners[name] = fn; },
    append(child) { this.children.push(child); }
  });
  return elements.get(id);
}
const context = vm.createContext({document: {
  getElementById: element, querySelectorAll: () => [], createElement: () => ({})
}});
new vm.Script(script).runInContext(context);
assert.match(element('volumes').innerHTML, /本地磁盘/);
assert.match(element('table').innerHTML, /MEMORY.DMP/i);
for (const tab of ['directories', 'largest', 'codex', 'comparison', 'issues', 'recommendations']) {
  element('tabs').listeners.click({target: {dataset: {tab}}});
  assert.ok(element('description').textContent);
  assert.ok(element('table').innerHTML);
}
element('search').value = 'never-match-4a09e8';
element('search').listeners.input();
assert.match(element('table').innerHTML, /没有匹配记录/);
element('search').value = '';
element('drive').value = 'c:\\';
element('drive').listeners.change();
assert.match(element('table').innerHTML, /MEMORY.DMP/i);
assert.ok(!element('table').innerHTML.includes('undefined'));
console.log('Report logic passed: six tabs, search, drive filter, real scan payload. Visual browser check not performed.');
