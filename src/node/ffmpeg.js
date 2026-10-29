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

/** Small JPEG preview of an image (max 480 px on the long side), kept after the original is deleted. */
export function makeThumb(bin, file, out) {
  return new Promise((resolve) => {
    execFile(bin, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', "scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease", '-q:v', '4', out], { timeout: 60000 }, (err) => resolve(!err && fs.existsSync(out)));
  });
}
