import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import ts from 'typescript';

const xml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export function option(name, fallback = null, argv = process.argv.slice(2)) {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  if (at === argv.length - 1 || argv[at + 1].startsWith('--'))
    throw new Error(`${name} requires a value`);
  return argv[at + 1];
}

export function numericOption(name, fallback, argv = process.argv.slice(2)) {
  const value = Number(option(name, fallback, argv));
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${name} must be a valid TCP port`);
  return value;
}

export function readCosmeticsFromConfig(configFile) {
  const source = readFileSync(configFile, 'utf8');
  const file = ts.createSourceFile(configFile, source, ts.ScriptTarget.Latest, true,
    ts.ScriptKind.TS);
  let array = null;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'COSMETICS') {
      let initializer = node.initializer;
      while (initializer && (ts.isAsExpression(initializer)
          || ts.isSatisfiesExpression?.(initializer)
          || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer)) array = initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!array) throw new Error(`Could not find a literal COSMETICS array in ${configFile}`);

  const literal = (node, field, index) => {
    if (!node) throw new Error(`COSMETICS[${index}] is missing ${field}`);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    throw new Error(`COSMETICS[${index}].${field} must be a literal for visual QA`);
  };
  const propertyName = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    return '';
  };
  const cosmetics = array.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element))
      throw new Error(`COSMETICS[${index}] must be an object literal`);
    const fields = new Map();
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      fields.set(propertyName(property.name), property.initializer);
    }
    return {
      id: literal(fields.get('id'), 'id', index),
      name: literal(fields.get('name'), 'name', index),
      desc: literal(fields.get('desc'), 'desc', index),
      cost: literal(fields.get('cost'), 'cost', index),
      slot: literal(fields.get('slot'), 'slot', index),
      value: literal(fields.get('value'), 'value', index),
    };
  });
  const ids = new Set();
  const supported = new Set(['ornament', 'dangler', 'horn', 'roof', 'decal', 'goop', 'sky']);
  for (const cosmetic of cosmetics) {
    if (ids.has(cosmetic.id)) throw new Error(`Duplicate cosmetic id: ${cosmetic.id}`);
    if (!supported.has(cosmetic.slot))
      throw new Error(`No visual-QA context is defined for slot "${cosmetic.slot}" (${cosmetic.id})`);
    ids.add(cosmetic.id);
  }
  if (!cosmetics.length) throw new Error('COSMETICS is empty');
  return cosmetics;
}

export async function connectAndroidWebView(port = 9222) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json`);
  } catch (error) {
    throw new Error(`Cannot reach Android WebView CDP on port ${port}. Run "adb forward tcp:${port} localabstract:webview_devtools_remote_<pid>" first. ${error.message}`);
  }
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  const pages = await response.json();
  const page = pages.find((candidate) =>
    candidate.type === 'page' && candidate.webSocketDebuggerUrl
      && /discipline|localhost|127\.0\.0\.1|capacitor/i.test(`${candidate.title || ''} ${candidate.url || ''}`))
    ?? pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  if (!page) throw new Error(`No debuggable Android WebView page found on forwarded port ${port}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening the Android WebView CDP socket')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`Android WebView CDP socket failed: ${event.message || 'unknown error'}`));
    }, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Android WebView CDP socket closed'));
    }
    pending.clear();
  });

  const call = (method, params = {}, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeoutMs = 20_000) => {
    const reply = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (reply.exceptionDetails) {
      const description = reply.exceptionDetails.exception?.description
        || reply.exceptionDetails.text
        || JSON.stringify(reply.exceptionDetails);
      throw new Error(`WebView evaluation failed: ${description}`);
    }
    return reply.result?.value;
  };
  const waitFor = async (expression, {
    timeoutMs = 10_000,
    intervalMs = 100,
    description = expression,
  } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
  };
  const capture = async () => {
    const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!result?.data) throw new Error('CDP returned no screenshot data');
    return Buffer.from(result.data, 'base64');
  };

  await call('Runtime.enable');
  await call('Page.enable');
  return {
    port,
    page,
    call,
    evaluate,
    waitFor,
    capture,
    close: () => socket.close(),
  };
}

export async function requireVisualAuditHandles(cdp, extraMethods = []) {
  const result = await cdp.evaluate(`(() => {
    const missing = [];
    if (!window.__game) missing.push('window.__game');
    if (!window.__ui) missing.push('window.__ui');
    if (!window.__scene) missing.push('window.__scene');
    if (!document.querySelector('#game-canvas')) missing.push('#game-canvas');
    const required = ${JSON.stringify(extraMethods)};
    for (const name of required) {
      const [owner, method] = name.split('.');
      const value = owner === 'scene' ? window.__scene
        : owner === 'ui' ? window.__ui
          : owner === 'game' ? window.__game : null;
      if (!value || typeof value[method] !== 'function') missing.push(name);
    }
    return {
      missing,
      href: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  })()`);
  if (result.missing.length) {
    throw new Error(`Visual-audit handles are missing (${result.missing.join(', ')}). Install and launch the exact "npm run build:test" APK; a production APK intentionally omits these handles.`);
  }
  return result;
}

export async function writeLabeledPng(rawPng, file, title, subtitle = '') {
  const metadata = await sharp(rawPng).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Invalid PNG capture for ${title}`);
  const labelHeight = subtitle ? 58 : 40;
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${metadata.width}" height="${labelHeight}">
    <rect width="100%" height="100%" fill="#11131d"/>
    <text x="12" y="24" fill="#ffd890" font-family="monospace" font-size="16" font-weight="700">${xml(title)}</text>
    ${subtitle ? `<text x="12" y="45" fill="#b8b8d0" font-family="monospace" font-size="12">${xml(subtitle)}</text>` : ''}
  </svg>`);
  mkdirSync(dirname(file), { recursive: true });
  await sharp({
    create: {
      width: metadata.width,
      height: metadata.height + labelHeight,
      channels: 4,
      background: '#080910',
    },
  }).composite([
    { input: label, left: 0, top: 0 },
    { input: rawPng, left: 0, top: labelHeight },
  ]).png().toFile(file);
  const stats = await sharp(rawPng).stats();
  const variation = stats.channels.reduce((sum, channel) => sum + channel.stdev, 0);
  if (variation < 4) throw new Error(`Screenshot for ${title} is effectively blank`);
  return {
    width: metadata.width,
    height: metadata.height,
    labeledHeight: metadata.height + labelHeight,
    variation,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}

export async function writeContactSheet(items, output, {
  columns = 4,
  tileWidth = 260,
  tileHeight = 450,
} = {}) {
  if (!items.length) throw new Error(`Cannot create empty contact sheet ${output}`);
  const rows = Math.ceil(items.length / columns);
  const layers = [];
  for (const [index, item] of items.entries()) {
    const image = await sharp(item.file)
      .resize(tileWidth, tileHeight, { fit: 'contain', background: '#080910' })
      .png().toBuffer();
    layers.push({
      input: image,
      left: (index % columns) * tileWidth,
      top: Math.floor(index / columns) * tileHeight,
    });
  }
  mkdirSync(dirname(output), { recursive: true });
  await sharp({
    create: {
      width: columns * tileWidth,
      height: rows * tileHeight,
      channels: 4,
      background: '#080910',
    },
  }).composite(layers).png().toFile(output);
  return output;
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
