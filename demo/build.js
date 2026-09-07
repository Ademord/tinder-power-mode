// Build the public Pages directory from the real distributed userscript.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(__dirname, 'src.html'), 'utf8');
const artifact = fs.readFileSync(path.join(root, 'tinder-power-mode.user.js'), 'utf8');
const script = artifact.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
const marker = '/*__USERSCRIPT__*/';
if (source.split(marker).length !== 2) throw new Error('Expected exactly one userscript slot');
if (/<\/script/i.test(script)) throw new Error('Cannot safely inline a closing script tag');
const fragment = source.replace(marker, () => script);
const cut = fragment.indexOf('</style>') + '</style>'.length;
if (cut < '</style>'.length) throw new Error('Expected a style block');
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="description" content="Try Tinder Power Mode using fictional profiles. Keyboard shortcuts, photo navigation, focus mode and remapping powered by the actual userscript.">\n<link rel="icon" href="data:,">\n${fragment.slice(0, cut)}\n</head>\n<body>${fragment.slice(cut)}\n</body>\n</html>\n`;
const out = path.join(root, 'docs');
const files = { 'index.html': full, 'tinder-power-mode.user.js': artifact, '.nojekyll': '' };
if (fs.existsSync(out)) {
  const unexpected = fs.readdirSync(out).filter(name => !Object.hasOwn(files, name));
  if (unexpected.length) throw new Error(`Unexpected Pages files: ${unexpected.join(', ')}`);
}
if (process.argv.includes('--check')) {
  for (const [name, content] of Object.entries(files)) {
    if (!fs.existsSync(path.join(out, name)) || fs.readFileSync(path.join(out, name), 'utf8') !== content) throw new Error(`docs/${name} is stale; run npm run build`);
  }
  console.log('Pages output matches source');
} else {
  fs.mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), content);
  console.log('Built docs/index.html, docs/tinder-power-mode.user.js and docs/.nojekyll');
}
