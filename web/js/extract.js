/*
 * 文档识别：PDF 文字层、Word(.docx) 正文、图片 OCR。
 * 只负责把文件转成纯文本，词条切分仍交给 core.parseImport，保持既有排版规则。
 */
(function (global) {
  'use strict';

  var PDF_SCRIPT = 'vendor/pdfjs/pdf.min.js';
  var PDF_WORKER = 'vendor/pdfjs/pdf.worker.min.js';
  var TESS_SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var TESS_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/';

  var pdfPromise = null;
  var tessPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('加载识别组件失败，请检查网络')); };
      document.head.appendChild(s);
    });
  }

  function loadPdf() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (!pdfPromise) {
      pdfPromise = loadScript(PDF_SCRIPT).then(function () {
        if (!global.pdfjsLib) throw new Error('PDF 组件未就绪');
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        return global.pdfjsLib;
      });
    }
    return pdfPromise;
  }

  function loadTesseract() {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    if (!tessPromise) {
      tessPromise = loadScript(TESS_SCRIPT).then(function () {
        if (!global.Tesseract) throw new Error('OCR 组件未就绪');
        return global.Tesseract;
      });
    }
    return tessPromise;
  }

  function kindOf(file) {
    var name = (file && file.name ? file.name : '').toLowerCase();
    var type = (file && file.type ? file.type : '').toLowerCase();
    if (/\.pdf$/.test(name) || type === 'application/pdf') return 'pdf';
    if (/\.docx$/.test(name)) return 'docx';
    if (/\.doc$/.test(name)) return 'doc';
    if (/^image\//.test(type) || /\.(png|jpe?g|webp|heic|heif|bmp)$/.test(name)) return 'image';
    return 'text';
  }

  async function readPdf(file, onProgress) {
    var lib = await loadPdf();
    var data;
    try {
      data = new Uint8Array(await file.arrayBuffer());
      var doc = await lib.getDocument({ data: data }).promise;
      var out = [];
      for (var p = 1; p <= doc.numPages; p++) {
        var page = await doc.getPage(p);
        var content = await page.getTextContent();
        var line = '';
        content.items.forEach(function (item) {
          if (item.str) line += item.str;
          if (item.hasEOL) { out.push(line); line = ''; }
        });
        if (line) out.push(line);
        out.push('');
        if (onProgress) onProgress(p, doc.numPages);
      }
      var text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) throw new Error('这份 PDF 没有文字层，请截图后用图片识别');
      return text;
    } catch (err) {
      if (err && /password/i.test(err.name || '') ) throw new Error('PDF 有密码，暂时无法读取');
      throw err;
    }
  }

  function findEocd(view) {
    var start = Math.max(0, view.byteLength - 66000);
    for (var i = view.byteLength - 22; i >= start; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 Word 解压，请升级系统或改用 txt');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzipEntry(file, wanted) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var view = new DataView(bytes.buffer);
    var eocd = findEocd(view);
    if (eocd < 0) throw new Error('不是有效的 Word 文档');
    var count = view.getUint16(eocd + 10, true);
    var pos = view.getUint32(eocd + 16, true);
    for (var i = 0; i < count; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      var method = view.getUint16(pos + 10, true);
      var size = view.getUint32(pos + 20, true);
      var nameLen = view.getUint16(pos + 28, true);
      var extraLen = view.getUint16(pos + 30, true);
      var commentLen = view.getUint16(pos + 32, true);
      var local = view.getUint32(pos + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      if (name === wanted) {
        var localName = view.getUint16(local + 26, true);
        var localExtra = view.getUint16(local + 28, true);
        var start = local + 30 + localName + localExtra;
        var chunk = bytes.subarray(start, start + size);
        return method === 0 ? chunk : await inflateRaw(chunk);
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('Word 文档里没有正文');
  }

  function decodeXml(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function readDocx(file) {
    var xml = decodeXml(await unzipEntry(file, 'word/document.xml'));
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var paras = doc.getElementsByTagNameNS('*', 'p');
    var lines = [];
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      var text = '';
      var nodes = p.getElementsByTagNameNS('*', 't');
      for (var k = 0; k < nodes.length; k++) text += nodes[k].textContent;
      if (!text && p.getElementsByTagNameNS('*', 'tab').length) text = '\t';
      lines.push(text.replace(/\u00a0/g, ' '));
    }
    var text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('Word 文档里没有可读取的文字');
    return text;
  }

  function tidyOcr(text) {
    var out = text.replace(/\r/g, '').replace(/[ \t\u00a0\u3000]+/g, ' ');
    // OCR 常在汉字之间插空格；用 lookahead 一次收拢，英文单词间空格保留
    out = out.replace(/([\u3400-\u9fff\u3000-\u303f\uff00-\uffef]) +(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1');
    // 汉字与 ASCII 标点之间的空格也收拢（OCR 常把冒号识别成半角）
    out = out.replace(/([\u3400-\u9fff])\s+([:;,.!?])/g, '$1$2');
    out = out.replace(/([\u3400-\u9fff])([:;,.!?])\s+(?=[\u3400-\u9fff])/g, '$1$2');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }

  async function readImage(file, onProgress) {
    var T = await loadTesseract();
    var result = await T.recognize(file, 'chi_sim', {
      langPath: TESS_LANG,
      logger: function (m) {
        if (onProgress && m && m.status) onProgress(Number(m.progress) || 0, m.status);
      }
    });
    var text = tidyOcr((result && result.data && result.data.text) || '');
    if (!text) throw new Error('没有识别到文字，换一张更清晰的截图试试');
    return text;
  }

  async function extract(file, onProgress) {
    var kind = kindOf(file);
    if (kind === 'pdf') return readPdf(file, onProgress);
    if (kind === 'docx') return readDocx(file);
    if (kind === 'doc') throw new Error('暂不支持旧版 .doc，请另存为 .docx 后导入');
    if (kind === 'image') return readImage(file, onProgress);
    return file.text();
  }

  global.MJZ = global.MJZ || {};
  global.MJZ.extract = { kindOf: kindOf, extract: extract };
})(typeof window !== 'undefined' ? window : globalThis);
