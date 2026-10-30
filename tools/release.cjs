'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main';
const SCRIPT = 'video-helper.user.js';
const META = 'video-helper.meta.js';
const NAME = '学习通视频助手：弹题逐项重试';
const NAMESPACE = 'local.chaoxing.video-helper';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Expected a version such as 3.2.5');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version is too large');
  return parts;
}

function compare(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function header(source) {
  const match = source.match(/^\/\/ ==UserScript==\r?\n[\s\S]*?^\/\/ ==\/UserScript==[^\S\r\n]*(?:\r?\n|$)/m);
  if (!match || match.index !== 0) throw new Error('Missing userscript header');
  return match[0];
}

function field(source, name) {
  const values = header(source).split(/\r?\n/).map(line => line.match(/^\/\/\s+@(\S+)\s+(.+?)\s*$/)).filter(row => row && row[1] === name);
  if (values.length !== 1) throw new Error('Expected exactly one @' + name);
  return values[0][2];
}

function bundle(script) {
  const version = field(script, 'version');
  versionParts(version);
  if (field(script, 'name') !== NAME || field(script, 'namespace') !== NAMESPACE) throw new Error('Userscript identity changed');
  if (field(script, 'updateURL') !== BASE + '/' + META || field(script, 'downloadURL') !== BASE + '/' + SCRIPT) throw new Error('Unexpected update address');
  const markers = [...script.slice(header(script).length).matchAll(/\bconst VERSION = '([^']+)';/g)];
  if (markers.length !== 1 || markers[0][1] !== version) throw new Error('UI version differs from metadata');
  new vm.Script(script, {filename: SCRIPT});
  const meta = header(script);
  return {version, script, meta, manifest: {schema: 1, channel: 'stable', version, files: {
    [SCRIPT]: {sha256: hash(script)},
    [META]: {sha256: hash(meta)},
  }}};
}

function checksums(root) {
  const names = [SCRIPT, META];
  const directory = path.join(root, 'versions');
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (/^video-helper-\d+\.\d+\.\d+\.user\.js$/.test(name)) names.push('versions/' + name);
    }
  }
  return names.sort().map(name => hash(fs.readFileSync(path.join(root, name))) + '  ' + name).join('\n') + '\n';
}

function check(root = ROOT) {
  const result = bundle(fs.readFileSync(path.join(root, SCRIPT), 'utf8'));
  if (fs.readFileSync(path.join(root, META), 'utf8') !== result.meta) throw new Error('Metadata file differs from script header');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.channel !== 'stable' || manifest.version !== result.version) throw new Error('Release manifest version differs');
  for (const name of [SCRIPT, META]) if (manifest.files?.[name]?.sha256 !== result.manifest.files[name].sha256) throw new Error('Checksum mismatch: ' + name);
  const archive = path.join(root, 'versions', 'video-helper-' + result.version + '.user.js');
  if (!fs.readFileSync(archive).equals(Buffer.from(result.script))) throw new Error('Version archive differs from current script');
  if (fs.readFileSync(path.join(root, 'CHECKSUMS.sha256'), 'utf8') !== checksums(root)) throw new Error('CHECKSUMS.sha256 differs');
  return result;
}

function write(result, root = ROOT) {
  const archive = path.join(root, 'versions', 'video-helper-' + result.version + '.user.js');
  if (fs.existsSync(archive) && !fs.readFileSync(archive).equals(Buffer.from(result.script))) throw new Error('Refusing to replace an existing version archive');
  fs.mkdirSync(path.dirname(archive), {recursive: true});
  fs.writeFileSync(archive, result.script);
  fs.writeFileSync(path.join(root, SCRIPT), result.script);
  fs.writeFileSync(path.join(root, META), result.meta);
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'CHECKSUMS.sha256'), checksums(root));
  return check(root);
}

function prepare(version, root = ROOT) {
  versionParts(version);
  const source = fs.readFileSync(path.join(root, SCRIPT), 'utf8');
  const oldVersion = field(source, 'version');
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (compare(version, oldVersion) <= 0 || compare(version, previous.version) <= 0) throw new Error('New version must be higher than the existing release');
  const meta = header(source).replace(/(@version\s+)\S+/, (_, prefix) => prefix + version);
  const marker = "const VERSION = '" + oldVersion + "';";
  const body = source.slice(header(source).length);
  if (body.split(marker).length !== 2) throw new Error('Expected exactly one UI version declaration');
  return write(bundle(meta + body.replace(marker, "const VERSION = '" + version + "';")), root);
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command !== 'check' && command !== 'prepare') throw new Error('Usage: node tools/release.cjs check | prepare <version>');
    const result = command === 'check' ? check() : prepare(process.argv[3]);
    console.log('Validated ' + result.version + '. Review and push all release files in one commit.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {BASE, hash, header, field, bundle, checksums, check, write, prepare};
