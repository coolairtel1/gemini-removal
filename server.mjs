// Web UI local cho gemini-watermark-remover.
// Chạy: npm start  →  mở http://localhost:5178
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  removeWatermarkFromBuffer,
  inferMimeTypeFromPath,
  inferVideoMimeTypeFromPath,
  isVideoMimeType
} from '@pilio/gemini-watermark-remover/node';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'output');
const PORT = Number(process.env.PORT) || 5178;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

/** @type {Map<string, object>} */
const jobs = new Map();
// Video chạy qua Chromium headless, nặng nên xử lý tuần tự từng file.
let videoQueue = Promise.resolve();

const codec = {
  async decodeImageData(buffer) {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: Uint8ClampedArray.from(data) };
  },
  async encodeImageData(imageData, context = {}) {
    let encoder = sharp(Buffer.from(imageData.data), {
      raw: { width: imageData.width, height: imageData.height, channels: 4 }
    });
    if (context.mimeType === 'image/jpeg') encoder = encoder.jpeg({ quality: 95 });
    else if (context.mimeType === 'image/webp') encoder = encoder.webp({ quality: 95 });
    else encoder = encoder.png();
    return encoder.toBuffer();
  }
};

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-()À-ỹ ]+/g, '_');
  return base || 'file';
}

function publicJob(job) {
  const { inputPath, outputPath, child, ...rest } = job;
  return rest;
}

async function processImage(job) {
  const input = await readFile(job.inputPath);
  const mimeType = inferMimeTypeFromPath(job.outputPath);
  const started = Date.now();
  const result = await removeWatermarkFromBuffer(input, { mimeType, filePath: job.outputPath, ...codec });
  await writeFile(job.outputPath, result.buffer);
  const meta = result.meta || {};
  Object.assign(job, {
    status: 'done',
    progress: 1,
    elapsedMs: Date.now() - started,
    applied: meta.applied !== false,
    detail: meta.applied === false
      ? 'Không phát hiện watermark Gemini — ảnh giữ nguyên.'
      : `Đã xóa watermark${meta.decisionTier ? ` (${meta.decisionTier})` : ''}.`
  });
}

// Mỗi video chạy trong một process con (video-worker.mjs) để hủy được giữa chừng.
function processVideo(job) {
  if (job.status === 'cancelled') return Promise.resolve();
  const started = Date.now();
  job.status = 'processing';
  job.detail = 'Đang khởi động Chromium…';

  return new Promise((resolve, reject) => {
    const args = [path.join(ROOT, 'video-worker.mjs'), job.inputPath, job.outputPath];
    if (job.bitrateMbps) args.push(String(job.bitrateMbps));
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    job.child = child;
    let workerError = null;

    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'error') workerError = msg.message;
        if (msg.type !== 'progress' || job.status !== 'processing') continue;
        if (Number.isFinite(msg.progress)) job.progress = msg.progress;
        const frames = Number.isFinite(msg.processedFrames)
          ? ` · ${msg.processedFrames}${Number.isFinite(msg.frameEstimate) ? `/${msg.frameEstimate}` : ''} khung hình`
          : '';
        job.detail = `${msg.phase || 'Đang xử lý'}${frames}`;
      }
    });

    child.on('exit', (code) => {
      job.child = null;
      if (job.status === 'cancelled') {
        rm(job.outputPath, { force: true }).finally(resolve);
        return;
      }
      if (code !== 0) {
        reject(new Error(workerError || `Video worker thoát với mã ${code}`));
        return;
      }
      Object.assign(job, {
        status: 'done',
        progress: 1,
        applied: true,
        elapsedMs: Date.now() - started,
        detail: 'Đã xử lý video.'
      });
      resolve();
    });
  });
}

function cancelJob(job) {
  if (job.status !== 'queued' && job.status !== 'processing') return false;
  job.status = 'cancelled';
  job.detail = 'Đã hủy.';
  if (job.child) {
    // SIGTERM để Playwright tự đóng Chromium; nếu kẹt thì SIGKILL.
    const child = job.child;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000).unref();
  }
  return true;
}

function runJob(job, fn) {
  return fn(job).catch((error) => {
    console.error(`[${job.name}]`, error);
    job.status = 'error';
    job.detail = error?.message || String(error);
  });
}

async function handleUpload(req, res, url) {
  const name = safeName(decodeURIComponent(url.searchParams.get('name') || 'file'));
  const bitrateMbps = Number(url.searchParams.get('bitrate')) || null;
  const id = randomUUID();
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  const inputPath = path.join(UPLOAD_DIR, `${id}${ext}`);
  const outputName = `${stem}_clean${ext}`;
  const outputPath = path.join(OUTPUT_DIR, `${id.slice(0, 8)}_${outputName}`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: 'File quá lớn (giới hạn 1GB).' });
    chunks.push(chunk);
  }
  await writeFile(inputPath, Buffer.concat(chunks));

  const isVideo = isVideoMimeType(inferVideoMimeTypeFromPath(name));
  const isImage = /\.(png|jpe?g|webp)$/i.test(name);
  if (!isVideo && !isImage) return sendJson(res, 400, { error: 'Chỉ hỗ trợ PNG, JPG, WEBP, MP4, WEBM, MOV.' });

  const job = {
    id, name, outputName, kind: isVideo ? 'video' : 'image',
    status: isVideo ? 'queued' : 'processing',
    progress: 0, detail: isVideo ? 'Đang chờ hàng đợi…' : 'Đang xử lý…',
    bitrateMbps, inputPath, outputPath
  };
  jobs.set(id, job);

  if (isVideo) {
    videoQueue = videoQueue.then(() => runJob(job, processVideo));
  } else {
    await runJob(job, processImage);
  }
  sendJson(res, 200, publicJob(job));
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendFile(res, filePath, { contentType, downloadName } = {}) {
  const headers = { 'content-type': contentType || 'application/octet-stream' };
  if (downloadName) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  res.writeHead(200, headers);
  createReadStream(filePath).on('error', () => res.end()).pipe(res);
}

// Ghi file ZIP kiểu "store" (không nén — ảnh/video đã nén sẵn) thẳng ra response.
async function sendZip(res, entries, zipName) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`
  });
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve) => {
    offset += buf.length;
    if (res.write(buf)) resolve(); else res.once('drain', resolve);
  });

  for (const { filePath, name } of entries) {
    const data = await readFile(filePath);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // tên file UTF-8
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    await write(header);
    await write(nameBuf);
    await write(data);
  }

  const centralStart = offset;
  for (const buf of central) await write(buf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  res.end(end);
}

function uniqueNames(jobsToZip) {
  const used = new Set();
  return jobsToZip.map((job) => {
    const ext = path.extname(job.outputName);
    const stem = path.basename(job.outputName, ext);
    let name = job.outputName;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
    used.add(name.toLowerCase());
    return { filePath: job.outputPath, name };
  });
}

function mimeFor(filePath) {
  const video = inferVideoMimeTypeFromPath(filePath);
  return isVideoMimeType(video) ? video : inferMimeTypeFromPath(filePath);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      return sendFile(res, path.join(ROOT, 'public', 'index.html'), { contentType: 'text/html; charset=utf-8' });
    }
    const asset = url.pathname.match(/^\/assets\/([\w.-]+\.(webp|png|jpg|svg))$/);
    if (req.method === 'GET' && asset) {
      const types = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };
      return sendFile(res, path.join(ROOT, 'public', 'assets', asset[1]), { contentType: types[asset[2]] });
    }
    if (req.method === 'POST' && url.pathname === '/api/process') {
      return await handleUpload(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/api/download-all') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const done = ids.map((id) => jobs.get(id)).filter((job) => job?.status === 'done');
      if (done.length === 0) return sendJson(res, 404, { error: 'Không có file nào đã xử lý xong.' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      return await sendZip(res, uniqueNames(done), `gemini-clean-${stamp}.zip`);
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel-all') {
      const cancelled = [...jobs.values()].filter(cancelJob).map((job) => job.id);
      return sendJson(res, 200, { cancelled });
    }
    const cancelMatch = url.pathname.match(/^\/api\/cancel\/([\w-]+)$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Không tìm thấy job.' });
      cancelJob(job);
      return sendJson(res, 200, publicJob(job));
    }
    const match = url.pathname.match(/^\/api\/(job|result|original)\/([\w-]+)$/);
    if (req.method === 'GET' && match) {
      const job = jobs.get(match[2]);
      if (!job) return sendJson(res, 404, { error: 'Không tìm thấy job.' });
      if (match[1] === 'job') return sendJson(res, 200, publicJob(job));
      if (match[1] === 'original') return sendFile(res, job.inputPath, { contentType: mimeFor(job.inputPath) });
      if (job.status !== 'done') return sendJson(res, 409, { error: 'Chưa xử lý xong.' });
      const download = url.searchParams.has('download');
      return sendFile(res, job.outputPath, {
        contentType: mimeFor(job.outputPath),
        downloadName: download ? job.outputName : undefined
      });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error?.message || String(error) });
  }
});

// Tắt server thì dừng luôn các video đang chạy, không để Chromium mồ côi.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const job of jobs.values()) job.child?.kill('SIGTERM');
    process.exit(0);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gemini Watermark Remover UI: http://localhost:${PORT}`);
  console.log(`File kết quả được lưu ở: ${OUTPUT_DIR}`);
});
