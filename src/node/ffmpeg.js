// Optional ffmpeg/ffprobe integration (Node only; disabled on Cloudflare Workers).
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/** ffprobe fallback when the JS MP4 parser found nothing (FFPROBE_PATH). */
export function ffprobe(bin, file) {
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { timeout: 30000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve({ width: j.streams?.[0]?.width ?? null, height: j.streams?.[0]?.height ?? null, duration: j.format?.duration ? Number(j.format.duration) : null });
      } catch { resolve(null); }
    });
  });
}

/** Poster frame (JPEG) for video previews (FFMPEG_PATH). */
export function makePoster(bin, file, out) {
  return new Promise((resolve) => {
    execFile(bin, ['-y', '-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', out], { timeout: 60000 }, (err) => resolve(!err && fs.existsSync(out)));
  });
}
