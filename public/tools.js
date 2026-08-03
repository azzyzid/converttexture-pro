(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function cleanBaseName(name) {
    return String(name || 'resource-pack').replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'resource-pack';
  }

  function sanitizeId(value) {
    return String(value || 'item').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function detectRoot(zip) {
    if (zip.file('pack.mcmeta')) return '';
    const candidates = Object.keys(zip.files).filter(name => /(^|\/)pack\.mcmeta$/i.test(name));
    if (!candidates.length) return '';
    return candidates[0].slice(0, -'pack.mcmeta'.length);
  }

  async function readJson(zip, path) {
    const entry = zip.file(path);
    if (!entry) return null;
    try { return JSON.parse(await entry.async('text')); }
    catch { return null; }
  }

  function writeJson(zip, path, value, minify = false) {
    zip.file(path, JSON.stringify(value, null, minify ? 0 : 2));
  }

  async function sha256(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function resourceIdFromTexturePath(path, root = '') {
    const local = root && path.startsWith(root) ? path.slice(root.length) : path;
    const match = local.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/i);
    return match ? `${match[1]}:${match[2]}` : null;
  }

  function modelPathFromId(modelId, root = '') {
    const [namespace, rawPath] = String(modelId).includes(':') ? String(modelId).split(':', 2) : ['minecraft', String(modelId)];
    return `${root}assets/${namespace}/models/${rawPath}.json`;
  }

  function texturePathFromId(textureId, root = '') {
    const [namespace, rawPath] = String(textureId).includes(':') ? String(textureId).split(':', 2) : ['minecraft', String(textureId)];
    return `${root}assets/${namespace}/textures/${rawPath}.png`;
  }

  function replaceStringsDeep(value, replacements) {
    if (typeof value === 'string') return replacements.get(value) || value;
    if (Array.isArray(value)) return value.map(item => replaceStringsDeep(item, replacements));
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = replaceStringsDeep(value[key], replacements);
    }
    return value;
  }

  function collectStringsDeep(value, out) {
    if (typeof value === 'string') { out.add(value); return; }
    if (Array.isArray(value)) { value.forEach(item => collectStringsDeep(item, out)); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(item => collectStringsDeep(item, out));
  }

  function nextPowerOfTwo(value) {
    let n = 1;
    while (n < value) n *= 2;
    return n;
  }

  async function pngToCanvas(buffer) {
    const blob = new Blob([buffer], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { canvas, context };
  }

  function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function canvasToPng(canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Browser gagal menulis PNG.');
    return blob.arrayBuffer();
  }

  async function transformPng(buffer, options) {
    const originalSize = buffer.byteLength;
    let { canvas, context } = await pngToCanvas(buffer);
    const originalWidth = canvas.width, originalHeight = canvas.height;
    let changed = false, downscaled = false, paletteReduced = false, padded = false;

    if (options.downscale && Math.max(canvas.width, canvas.height) > options.maxDimension) {
      const scale = options.maxDimension / Math.max(canvas.width, canvas.height);
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      const next = document.createElement('canvas');
      next.width = width; next.height = height;
      const nextContext = next.getContext('2d', { alpha: true, willReadFrequently: true });
      nextContext.imageSmoothingEnabled = false;
      nextContext.drawImage(canvas, 0, 0, width, height);
      canvas = next; context = nextContext; changed = true; downscaled = true;
    }

    if (options.power2) {
      const width = nextPowerOfTwo(canvas.width);
      const height = nextPowerOfTwo(canvas.height);
      if (width !== canvas.width || height !== canvas.height) {
        const next = document.createElement('canvas');
        next.width = width; next.height = height;
        const nextContext = next.getContext('2d', { alpha: true, willReadFrequently: true });
        nextContext.imageSmoothingEnabled = false;
        nextContext.drawImage(canvas, 0, 0);
        canvas = next; context = nextContext; changed = true; padded = true;
      }
    }

    if (options.lossy) {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const step = options.quality === 'high' ? 6 : options.quality === 'low' ? 32 : 16;
      const alphaStep = options.quality === 'low' ? 12 : options.quality === 'medium' ? 4 : 1;
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.min(255, Math.round(imageData.data[i] / step) * step);
        imageData.data[i + 1] = Math.min(255, Math.round(imageData.data[i + 1] / step) * step);
        imageData.data[i + 2] = Math.min(255, Math.round(imageData.data[i + 2] / step) * step);
        if (alphaStep > 1) imageData.data[i + 3] = Math.min(255, Math.round(imageData.data[i + 3] / alphaStep) * alphaStep);
      }
      context.putImageData(imageData, 0, 0);
      changed = true; paletteReduced = true;
    }

    if (!changed && !options.reencode) {
      return { buffer, changed: false, keptOriginal: true, originalWidth, originalHeight, width: originalWidth, height: originalHeight, downscaled: false, paletteReduced: false, padded: false };
    }
    const output = await canvasToPng(canvas);
    if (options.keepSmaller && output.byteLength >= originalSize && !downscaled && !padded) {
      return { buffer, changed: false, keptOriginal: true, originalWidth, originalHeight, width: originalWidth, height: originalHeight, downscaled: false, paletteReduced: false, padded: false };
    }
    return { buffer: output, changed: true, keptOriginal: false, originalWidth, originalHeight, width: canvas.width, height: canvas.height, downscaled, paletteReduced, padded };
  }

  async function convertVersion(file, options = {}) {
    const log = options.log || (() => {});
    const progress = options.progress || (() => {});
    log('Membaca resource pack ZIP...');
    const zip = await JSZip.loadAsync(file);
    const root = detectRoot(zip);
    const target = Number(options.targetFormat || 34);
    const report = { targetFormat: target, root: root || '/', legacyConverted: 0, modernConverted: 0, warnings: [], files: Object.keys(zip.files).length };
    progress(10);

    const mcmetaPath = `${root}pack.mcmeta`;
    let mcmeta = await readJson(zip, mcmetaPath);
    if (!mcmeta) {
      mcmeta = { pack: { pack_format: target, description: 'Converted by ConvertTexture' } };
      report.warnings.push('pack.mcmeta tidak ditemukan; file baru dibuat.');
      log('⚠ pack.mcmeta tidak ditemukan. Membuat file baru.');
    }
    mcmeta.pack ||= {};
    const previousFormat = mcmeta.pack.pack_format;
    mcmeta.pack.pack_format = target;
    writeJson(zip, mcmetaPath, mcmeta, false);
    log(`pack_format: ${previousFormat ?? 'unknown'} → ${target}`);
    progress(20);

    if (target >= 46) {
      const modelPaths = Object.keys(zip.files).filter(path => path.startsWith(`${root}assets/minecraft/models/item/`) && path.endsWith('.json'));
      for (let index = 0; index < modelPaths.length; index++) {
        const path = modelPaths[index];
        const model = await readJson(zip, path);
        if (!model || !Array.isArray(model.overrides)) continue;
        const entries = model.overrides
          .filter(override => Number.isFinite(Number(override?.predicate?.custom_model_data)) && typeof override.model === 'string')
          .map(override => ({ threshold: Number(override.predicate.custom_model_data), model: { type: 'minecraft:model', model: override.model } }))
          .sort((a, b) => a.threshold - b.threshold);
        if (!entries.length) continue;
        const itemName = path.slice(`${root}assets/minecraft/models/item/`.length, -5);
        const itemPath = `${root}assets/minecraft/items/${itemName}.json`;
        const itemDefinition = {
          model: {
            type: 'minecraft:range_dispatch',
            property: 'minecraft:custom_model_data',
            fallback: { type: 'minecraft:model', model: `minecraft:item/${itemName}` },
            entries
          }
        };
        writeJson(zip, itemPath, itemDefinition, false);
        report.legacyConverted += entries.length;
        log(`✓ ${itemName}: ${entries.length} legacy override → item-model definition.`);
        progress(20 + Math.round(((index + 1) / Math.max(1, modelPaths.length)) * 45));
      }
      if (!report.legacyConverted) log('Tidak ditemukan override CustomModelData legacy yang perlu dikonversi.');
    } else {
      const itemPaths = Object.keys(zip.files).filter(path => path.startsWith(`${root}assets/minecraft/items/`) && path.endsWith('.json'));
      for (let index = 0; index < itemPaths.length; index++) {
        const path = itemPaths[index];
        const definition = await readJson(zip, path);
        const modelNode = definition?.model;
        if (!modelNode || modelNode.type !== 'minecraft:range_dispatch' || modelNode.property !== 'minecraft:custom_model_data' || !Array.isArray(modelNode.entries)) continue;
        const itemName = path.slice(`${root}assets/minecraft/items/`.length, -5);
        const legacyPath = `${root}assets/minecraft/models/item/${itemName}.json`;
        const legacy = (await readJson(zip, legacyPath)) || { parent: 'minecraft:item/generated', textures: { layer0: `minecraft:item/${itemName}` } };
        const existing = Array.isArray(legacy.overrides) ? legacy.overrides.filter(entry => !Number.isFinite(Number(entry?.predicate?.custom_model_data))) : [];
        const converted = modelNode.entries
          .filter(entry => Number.isFinite(Number(entry.threshold)) && entry?.model?.type === 'minecraft:model' && typeof entry.model.model === 'string')
          .map(entry => ({ predicate: { custom_model_data: Number(entry.threshold) }, model: entry.model.model }));
        if (!converted.length) continue;
        legacy.overrides = [...existing, ...converted].sort((a, b) => Number(a?.predicate?.custom_model_data || 0) - Number(b?.predicate?.custom_model_data || 0));
        writeJson(zip, legacyPath, legacy, false);
        report.modernConverted += converted.length;
        log(`✓ ${itemName}: ${converted.length} item-model entry → legacy override.`);
        progress(20 + Math.round(((index + 1) / Math.max(1, itemPaths.length)) * 45));
      }
      if (!report.modernConverted) log('Tidak ditemukan item-model range dispatch yang dapat diubah ke format legacy.');
    }

    progress(75);
    log('Memvalidasi struktur namespace, model, texture, font, dan glyph...');
    const paths = Object.keys(zip.files);
    const uppercase = paths.filter(path => /[A-Z ]/.test(path)).slice(0, 20);
    if (uppercase.length) {
      report.warnings.push(`${uppercase.length} path mengandung huruf besar atau spasi.`);
      log(`⚠ Ditemukan ${uppercase.length} path dengan huruf besar/spasi. Tidak diubah otomatis agar referensi tidak rusak.`);
    }
    const fontCount = paths.filter(path => /\/font\//.test(path) || /\/textures\/font\//.test(path)).length;
    if (fontCount) log(`✓ ${fontCount} file font/glyph dipertahankan tanpa modifikasi.`);

    progress(88);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, metadata => progress(88 + Math.round(metadata.percent * .12)));
    const filename = `${cleanBaseName(file.name)}-mc-format-${target}.zip`;
    log(`Selesai. Output: ${filename} (${formatBytes(blob.size)})`);
    return { blob, filename, report };
  }

  function isProtectedTexture(path, zip = null) {
    const normalized = `/${path}`;
    const sensitive = /\/textures\/(font|gui|colormap)\//i.test(normalized)
      || /\/font\//i.test(normalized)
      || /\/atlases\//i.test(normalized);
    const animated = Boolean(zip?.file(`${path}.mcmeta`));
    return sensitive || animated;
  }

  function isSourceArtifact(path) {
    return /(^|\/)\.git\//i.test(path)
      || /\.(psd|psb|xcf|kra|blend|blend1|aseprite|afdesign|ai|sketch|bak|tmp|orig)$/i.test(path)
      || /(~|\.backup)$/i.test(path);
  }

  async function optimizePack(file, options = {}) {
    const log = options.log || (() => {});
    const progress = options.progress || (() => {});
    log('Mengekstrak dan membaca struktur ZIP...');
    const zip = await JSZip.loadAsync(file);
    const root = detectRoot(zip);
    const preset = String(options.preset || 'custom').toLowerCase();
    const report = { preset, removedJunk: 0, removedSource: 0, removedShaders: 0, minified: 0, duplicates: 0, unused: 0, pngProcessed: 0, downscaled: 0, paletteReduced: 0, protected: 0, originalPngBytes: 0, outputPngBytes: 0, warnings: [] };
    log(`Preset: ${preset.toUpperCase()} · max texture ${Number(options.maxDimension || 512)}px · ${options.quality || 'medium'} palette`);
    progress(5);

    for (const path of Object.keys(zip.files)) {
      if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path) || /(^|\/)__MACOSX\//.test(path)) {
        zip.remove(path); report.removedJunk += 1;
      }
    }
    if (report.removedJunk) log(`✓ Menghapus ${report.removedJunk} file sampah sistem.`);

    if (options.removeSourceFiles) {
      for (const path of Object.keys(zip.files)) {
        if (isSourceArtifact(path)) { zip.remove(path); report.removedSource += 1; }
      }
      log(`✓ Source cleanup: ${report.removedSource} file editing/backup dihapus.`);
    }

    if (options.stripShaders) {
      for (const path of Object.keys(zip.files)) {
        if (/\/assets\/[^/]+\/shaders\//i.test(`/${path}`)) { zip.remove(path); report.removedShaders += 1; }
      }
      log(`✓ Strip shaders: ${report.removedShaders} file dihapus.`);
    }
    progress(12);

    const jsonPaths = Object.keys(zip.files).filter(path => /\.(json|mcmeta)$/i.test(path) && !zip.files[path].dir);
    const parsedJson = new Map();
    for (let i = 0; i < jsonPaths.length; i++) {
      const path = jsonPaths[i];
      const data = await readJson(zip, path);
      if (!data) { report.warnings.push(`JSON invalid: ${path}`); continue; }
      parsedJson.set(path, data);
      if (options.minifyJson) { writeJson(zip, path, data, true); report.minified += 1; }
      if (i % 30 === 0) progress(12 + Math.round((i / Math.max(1, jsonPaths.length)) * 12));
    }
    if (options.minifyJson) log(`✓ Minify ${report.minified} JSON/mcmeta.`);
    progress(25);

    const texturePaths = Object.keys(zip.files).filter(path => /\/textures\/.+\.png$/i.test(`/${path}`) && !zip.files[path].dir);
    report.protected = texturePaths.filter(path => isProtectedTexture(path, zip)).length;
    if (report.protected) log(`✓ Melindungi ${report.protected} texture font/glyph/GUI/dynamic.`);

    if (options.deduplicate) {
      const byHash = new Map();
      const replacements = new Map();
      for (let i = 0; i < texturePaths.length; i++) {
        const path = texturePaths[i];
        if (!zip.file(path)) continue;
        const buffer = await zip.file(path).async('arraybuffer');
        const hash = await sha256(buffer);
        const id = resourceIdFromTexturePath(path, root);
        if (byHash.has(hash)) {
          const canonical = byHash.get(hash);
          const canonicalId = resourceIdFromTexturePath(canonical, root);
          if (id && canonicalId && id !== canonicalId && !isProtectedTexture(path, zip)) {
            replacements.set(id, canonicalId);
            zip.remove(path); report.duplicates += 1;
          }
        } else byHash.set(hash, path);
        if (i % 10 === 0) progress(25 + Math.round((i / Math.max(1, texturePaths.length)) * 15));
      }
      if (replacements.size) {
        for (const [path, data] of parsedJson) {
          replaceStringsDeep(data, replacements);
          writeJson(zip, path, data, Boolean(options.minifyJson));
        }
      }
      log(`✓ Duplicate consolidation: ${report.duplicates} texture identik digabungkan.`);
    }
    progress(42);

    if (options.removeUnused) {
      const refs = new Set();
      for (const data of parsedJson.values()) collectStringsDeep(data, refs);
      const currentTextures = Object.keys(zip.files).filter(path => /\/textures\/(item|block)\/.+\.png$/i.test(`/${path}`) && !zip.files[path].dir);
      for (const path of currentTextures) {
        const id = resourceIdFromTexturePath(path, root);
        const namespace = id?.split(':')[0];
        if (!id || namespace === 'minecraft' || isProtectedTexture(path, zip)) continue;
        if (!refs.has(id)) { zip.remove(path); report.unused += 1; }
      }
      log(`✓ Safe unused scan: ${report.unused} texture custom tanpa referensi dihapus.`);
      if (report.unused) report.warnings.push('Periksa pack hasil jika plugin menggunakan texture melalui path dinamis yang tidak tertulis di JSON.');
    }
    progress(50);

    const pngOptions = {
      power2: Boolean(options.power2), downscale: Boolean(options.downscale),
      maxDimension: Number(options.maxDimension || 512), lossy: Boolean(options.lossy),
      quality: options.quality || 'medium', reencode: Boolean(options.reencode), keepSmaller: true
    };
    const shouldProcessPng = pngOptions.power2 || pngOptions.downscale || pngOptions.lossy || pngOptions.reencode;
    if (shouldProcessPng) {
      const current = Object.keys(zip.files).filter(path => /\.png$/i.test(path) && !zip.files[path].dir && !isProtectedTexture(path, zip));
      for (let i = 0; i < current.length; i++) {
        const path = current[i];
        try {
          const buffer = await zip.file(path).async('arraybuffer');
          report.originalPngBytes += buffer.byteLength;
          const transformed = await transformPng(buffer, pngOptions);
          report.outputPngBytes += transformed.buffer.byteLength;
          if (transformed.changed) {
            zip.file(path, transformed.buffer); report.pngProcessed += 1;
            if (transformed.downscaled) report.downscaled += 1;
            if (transformed.paletteReduced) report.paletteReduced += 1;
          }
        } catch (error) {
          report.warnings.push(`PNG dilewati: ${path} (${error.message})`);
        }
        progress(50 + Math.round(((i + 1) / Math.max(1, current.length)) * 32));
        if (i % 6 === 5) await yieldToBrowser();
      }
      const textureSaved = report.originalPngBytes ? Math.round((1 - report.outputPngBytes / report.originalPngBytes) * 1000) / 10 : 0;
      log(`✓ PNG pipeline: ${report.pngProcessed} diperbarui, ${report.downscaled} di-resize, ${report.paletteReduced} palette dikurangi.`);
      log(`✓ Penghematan texture yang diproses: ${formatBytes(report.originalPngBytes)} → ${formatBytes(report.outputPngBytes)} (${textureSaved >= 0 ? '-' : '+'}${Math.abs(textureSaved)}%).`);
    }

    progress(84);
    const mcmeta = await readJson(zip, `${root}pack.mcmeta`);
    if (!mcmeta) report.warnings.push('pack.mcmeta tidak ditemukan.');
    log(`Validasi selesai dengan ${report.warnings.length} peringatan.`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } }, metadata => progress(84 + Math.round(metadata.percent * .16)));
    const presetSuffix = /^[a-z]+$/.test(preset) ? `-${preset}` : '';
    const filename = `${cleanBaseName(file.name)}-optimized${presetSuffix}.zip`;
    const savedPercent = file.size ? Math.round((1 - blob.size / file.size) * 1000) / 10 : 0;
    if (savedPercent < 0) report.warnings.push('Output lebih besar dari input. Coba preset Medium/Low atau aktifkan downscale.');
    log(`Selesai: ${formatBytes(file.size)} → ${formatBytes(blob.size)} (${savedPercent >= 0 ? '-' : '+'}${Math.abs(savedPercent)}%).`);
    return { blob, filename, report, savedPercent };
  }

  async function resolveModelTexture(zip, root, modelId, visited = new Set()) {
    if (!modelId || visited.has(modelId)) return null;
    visited.add(modelId);
    const model = await readJson(zip, modelPathFromId(modelId, root));
    if (!model) return null;
    const textures = model.textures || {};
    let texture = textures.layer0 || textures.particle || Object.values(textures).find(value => typeof value === 'string' && !value.startsWith('#'));
    let guard = 0;
    while (typeof texture === 'string' && texture.startsWith('#') && guard < 8) {
      texture = textures[texture.slice(1)]; guard += 1;
    }
    if (typeof texture === 'string' && !texture.startsWith('#')) return texture.includes(':') ? texture : `minecraft:${texture}`;
    if (model.parent && model.parent.includes(':')) return resolveModelTexture(zip, root, model.parent, visited);
    return null;
  }

  function extractModelNodes(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'minecraft:model' && typeof node.model === 'string') out.push(node.model);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') extractModelNodes(value, out);
    }
    return out;
  }

  async function convertBedrock(file, options = {}) {
    const log = options.log || (() => {});
    const progress = options.progress || (() => {});
    const namespace = sanitizeId(options.namespace || 'converttexture');
    const packName = String(options.packName || 'ConvertTexture Pack').slice(0, 64);
    const fallbackBase = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.test(options.baseItem || '') ? options.baseItem : 'minecraft:paper';
    log('Membaca pack Java dan mencari custom item model...');
    const javaZip = await JSZip.loadAsync(file);
    const root = detectRoot(javaZip);
    const bedrockZip = new JSZip();
    const mappings = { format_version: 2, items: {} };
    const itemTexture = { resource_pack_name: packName, texture_name: 'atlas.items', texture_data: {} };
    const usedBedrockIds = new Set();
    const copiedTextureIds = new Set();
    const report = { legacy: 0, modern: 0, textures: 0, skipped: 0, warnings: [] };

    function uniqueBedrockId(raw) {
      const base = `${namespace}:${sanitizeId(raw)}`;
      let value = base, count = 2;
      while (usedBedrockIds.has(value)) value = `${base}_${count++}`;
      usedBedrockIds.add(value);
      return value;
    }

    async function addDefinition({ baseItem, modelId, customModelData, itemModelId, label }) {
      const textureId = await resolveModelTexture(javaZip, root, modelId);
      if (!textureId) { report.skipped += 1; report.warnings.push(`Tidak menemukan layer0 untuk model ${modelId}.`); return false; }
      const sourcePath = texturePathFromId(textureId, root);
      const source = javaZip.file(sourcePath);
      if (!source) { report.skipped += 1; report.warnings.push(`Texture hilang: ${textureId}.`); return false; }
      const safe = sanitizeId(`${textureId.replace(':', '_').replace(/\//g, '_')}_${customModelData ?? ''}`);
      const bedrockId = uniqueBedrockId(safe);
      const iconKey = bedrockId;
      const targetPath = `textures/items/${safe}.png`;
      if (!copiedTextureIds.has(textureId)) {
        bedrockZip.file(targetPath, await source.async('arraybuffer'));
        copiedTextureIds.add(textureId);
        report.textures += 1;
      } else {
        bedrockZip.file(targetPath, await source.async('arraybuffer'));
      }
      itemTexture.texture_data[iconKey] = { textures: [`textures/items/${safe}`] };
      mappings.items[baseItem] ||= [];
      if (Number.isFinite(Number(customModelData))) {
        mappings.items[baseItem].push({ type: 'legacy', custom_model_data: Number(customModelData), bedrock_identifier: bedrockId, display_name: label, bedrock_options: { icon: iconKey, creative_category: 'items' } });
        report.legacy += 1;
      } else {
        mappings.items[baseItem].push({ type: 'definition', model: itemModelId, bedrock_identifier: bedrockId, display_name: label, bedrock_options: { icon: iconKey, creative_category: 'items' } });
        report.modern += 1;
      }
      return true;
    }

    const legacyModels = Object.keys(javaZip.files).filter(path => path.startsWith(`${root}assets/minecraft/models/item/`) && path.endsWith('.json'));
    for (let i = 0; i < legacyModels.length; i++) {
      const path = legacyModels[i];
      const model = await readJson(javaZip, path);
      if (!Array.isArray(model?.overrides)) continue;
      const baseName = path.slice(`${root}assets/minecraft/models/item/`.length, -5);
      const baseItem = `minecraft:${baseName}`;
      for (const override of model.overrides) {
        if (!Number.isFinite(Number(override?.predicate?.custom_model_data)) || typeof override.model !== 'string') continue;
        await addDefinition({ baseItem, modelId: override.model, customModelData: Number(override.predicate.custom_model_data), label: override.model.split(':').pop().split('/').pop().replace(/_/g, ' ') });
      }
      progress(8 + Math.round(((i + 1) / Math.max(1, legacyModels.length)) * 35));
    }
    log(`Legacy scan: ${report.legacy} CustomModelData mapping dibuat.`);

    const modernItems = Object.keys(javaZip.files).filter(path => /^.*assets\/[^/]+\/items\/.+\.json$/i.test(path));
    for (let i = 0; i < modernItems.length; i++) {
      const path = modernItems[i];
      const local = root && path.startsWith(root) ? path.slice(root.length) : path;
      const match = local.match(/^assets\/([^/]+)\/items\/(.+)\.json$/i);
      if (!match) continue;
      const itemNamespace = match[1];
      const itemPath = match[2];
      const itemModelId = `${itemNamespace}:${itemPath}`;
      const definition = await readJson(javaZip, path);
      const modelIds = [...new Set(extractModelNodes(definition?.model))];
      if (!modelIds.length) continue;
      const baseItem = itemNamespace === 'minecraft' ? `minecraft:${itemPath}` : fallbackBase;
      if (itemNamespace === 'minecraft' && definition?.model?.type === 'minecraft:range_dispatch' && definition.model.property === 'minecraft:custom_model_data') continue;
      await addDefinition({ baseItem, modelId: modelIds[0], itemModelId, label: itemPath.split('/').pop().replace(/_/g, ' ') });
      if (modelIds.length > 1) report.warnings.push(`${itemModelId} memiliki model dinamis; hanya icon pertama yang digunakan.`);
      progress(45 + Math.round(((i + 1) / Math.max(1, modernItems.length)) * 22));
    }
    log(`Modern scan: ${report.modern} item_model mapping dibuat.`);

    if (options.includeAll) {
      const allItemTextures = Object.keys(javaZip.files).filter(path => /^.*assets\/[^/]+\/textures\/item\/.+\.png$/i.test(path));
      for (let i = 0; i < allItemTextures.length; i++) {
        const path = allItemTextures[i];
        const id = resourceIdFromTexturePath(path, root);
        if (!id || copiedTextureIds.has(id)) continue;
        const modelId = id.replace(':item/', ':item/');
        const source = javaZip.file(path);
        const safe = sanitizeId(id.replace(':', '_').replace(/\//g, '_'));
        const bedrockId = uniqueBedrockId(safe);
        bedrockZip.file(`textures/items/${safe}.png`, await source.async('arraybuffer'));
        itemTexture.texture_data[bedrockId] = { textures: [`textures/items/${safe}`] };
        mappings.items[fallbackBase] ||= [];
        mappings.items[fallbackBase].push({ type: 'definition', model: id.replace(':item/', ':'), bedrock_identifier: bedrockId, display_name: safe.replace(/_/g, ' '), bedrock_options: { icon: bedrockId, creative_category: 'items' } });
        copiedTextureIds.add(id); report.textures += 1; report.modern += 1;
      }
      log('Include-all scan selesai menggunakan fallback base item.');
    }
    progress(72);

    if (!report.legacy && !report.modern) throw new Error('Tidak ditemukan custom item mapping yang dapat dikonversi. Pastikan ZIP berisi model/item texture yang valid.');

    const manifest = {
      format_version: 2,
      header: { name: packName, description: 'Generated by ConvertTexture for GeyserMC', uuid: crypto.randomUUID(), version: [1, 0, 0], min_engine_version: [1, 20, 0] },
      modules: [{ type: 'resources', uuid: crypto.randomUUID(), version: [1, 0, 0] }]
    };
    bedrockZip.file('manifest.json', JSON.stringify(manifest, null, 2));
    bedrockZip.file('textures/item_texture.json', JSON.stringify(itemTexture, null, 2));
    bedrockZip.file('texts/languages.json', JSON.stringify(['en_US', 'id_ID'], null, 2));
    const langLines = Object.keys(itemTexture.texture_data).map(id => `item.${id.replace(':', ':')}.name=${id.split(':')[1].replace(/_/g, ' ')}`);
    bedrockZip.file('texts/en_US.lang', langLines.join('\n'));
    bedrockZip.file('texts/id_ID.lang', langLines.join('\n'));

    const mcpackBlob = await bedrockZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 7 } }, metadata => progress(72 + Math.round(metadata.percent * .12)));
    const safePack = cleanBaseName(packName);
    const mappingName = `${namespace}_mappings.json`;
    const bundle = new JSZip();
    bundle.file(`${safePack}.mcpack`, await mcpackBlob.arrayBuffer());
    bundle.file(`custom_mappings/${mappingName}`, JSON.stringify(mappings, null, 2));
    bundle.file('README_INSTALL.txt', [
      'ConvertTexture — Bedrock & GeyserMC output', '',
      `1. Copy ${safePack}.mcpack to Geyser packs/ folder.`,
      `2. Copy custom_mappings/${mappingName} to Geyser custom_mappings/ folder.`,
      '3. Enable custom content in Geyser configuration.',
      '4. Restart Geyser.', '',
      'Limitations: Java 3D geometry, entity displays, CIT, shaders, and custom fonts may require manual conversion.'
    ].join('\n'));
    bundle.file('conversion-report.json', JSON.stringify(report, null, 2));
    const bundleBlob = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 7 } }, metadata => progress(84 + Math.round(metadata.percent * .16)));
    const filename = `${cleanBaseName(file.name)}-bedrock-geyser.zip`;
    log(`✓ Membuat ${report.textures} texture, ${report.legacy + report.modern} mappings, dan Geyser bundle.`);
    if (report.warnings.length) log(`⚠ ${report.warnings.length} peringatan ditulis ke conversion-report.json.`);
    log(`Selesai: ${filename} (${formatBytes(bundleBlob.size)}).`);
    return { blob: bundleBlob, filename, report, mcpackBlob, mappingName };
  }

  window.TextureTools = { formatBytes, downloadBlob, convertVersion, optimizePack, convertBedrock, cleanBaseName };
})();
