// Xuất một video trong process riêng để server có thể hủy bằng cách kill process này.
// Dùng: node video-worker.mjs <input> <output> [bitrateMbps]
// In tiến độ ra stdout, mỗi dòng một JSON.
import { removeVideoWatermarkFromFile } from '@pilio/gemini-watermark-remover/node';

const [inputPath, outputPath, bitrateArg] = process.argv.slice(2);
const bitrateMbps = Number(bitrateArg) || null;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

try {
  await removeVideoWatermarkFromFile(inputPath, {
    outputPath,
    videoBitrate: bitrateMbps ? bitrateMbps * 1_000_000 : undefined,
    onProgress(p) {
      send({
        type: 'progress',
        progress: p.progress,
        phase: p.phase,
        processedFrames: p.processedFrames,
        frameEstimate: p.frameEstimate
      });
    }
  });
  send({ type: 'done' });
} catch (error) {
  send({ type: 'error', message: error?.message || String(error) });
  process.exitCode = 1;
}
