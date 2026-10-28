// Platform rules + validation. Pure ESM with no Node imports: served to the browser as-is
// (/assets/shared/validate.js) so the composer and the server apply identical rules.

export const PLATFORMS = {
  youtube: { label: 'YouTube', color: '#ff0033', maxCaption: 5000, captionLabel: 'Description' },
  facebook: { label: 'Facebook Page', color: '#1877f2', maxCaption: 63206, captionLabel: 'Message' },
  instagram: { label: 'Instagram (via Facebook)', color: '#d62976', maxCaption: 2200, captionLabel: 'Caption' },
  'instagram-standalone': { label: 'Instagram (Instagram Login)', color: '#962fbf', maxCaption: 2200, captionLabel: 'Caption' },
  x: { label: 'X', color: '#e7e9ea', maxCaption: 280, captionLabel: 'Post text', weighted: true },
  linkedin: { label: 'LinkedIn profile', color: '#0a66c2', maxCaption: 3000, captionLabel: 'Post text' },
  'linkedin-page': { label: 'LinkedIn Page', color: '#0a66c2', maxCaption: 3000, captionLabel: 'Post text' },
};

export const YOUTUBE_CATEGORIES = [
  ['1', 'Film & Animation'], ['2', 'Autos & Vehicles'], ['10', 'Music'], ['15', 'Pets & Animals'],
  ['17', 'Sports'], ['19', 'Travel & Events'], ['20', 'Gaming'], ['22', 'People & Blogs'],
  ['23', 'Comedy'], ['24', 'Entertainment'], ['25', 'News & Politics'], ['26', 'Howto & Style'],
  ['27', 'Education'], ['28', 'Science & Technology'], ['29', 'Nonprofits & Activism'],
];

export const LIMITS = {
  youtube: { titleMin: 2, titleMax: 100, tagsTotal: 500, shortMaxSec: 180, thumbMaxBytes: 2 * 1024 * 1024 },
  facebook: { maxPhotos: 10, photoMaxBytes: 4 * 1024 * 1024, reelMinSec: 3, reelMaxSec: 90, storyVideoMaxSec: 60, commentMax: 8000 },
  instagram: {
    maxCarousel: 10, minCarousel: 2, maxHashtags: 30, maxMentions: 20, maxCollaborators: 3,
    imageMaxBytes: 8 * 1024 * 1024, videoMaxBytes: 300 * 1024 * 1024,
    minRatio: 4 / 5, maxRatio: 1.91, reelMinSec: 3, reelMaxSec: 15 * 60, carouselVideoMaxSec: 60, storyVideoMaxSec: 60,
    commentMax: 2200,
  },
  // docs.x.com: 280 weighted characters (25,000 for X Premium long posts); up to 4 photos, 1 GIF or 1 video;
  // photos ≤ 5 MB, GIFs ≤ 15 MB; video ≤ 20 min / 8 GB (Premium: 125 min / 16 GB). Threads are reply chains.
  x: { maxChars: 280, premiumChars: 25000, maxImages: 4, imageMaxBytes: 5 * 1024 * 1024, gifMaxBytes: 15 * 1024 * 1024, videoMaxSec: 20 * 60, premiumVideoMaxSec: 125 * 60, videoMinSec: 0.5, videoMaxBytes: 8 * 1024 ** 3, maxThread: 25 },
  // learn.microsoft.com/linkedin: commentary ≤ 3000; MultiImage 2–20 images (JPG/GIF/PNG, < 36,152,320 px);
  // video MP4 3 s–30 min, 75 KB–500 MB; documents PDF/PPT(X)/DOC(X) ≤ 100 MB and 300 pages; comments ≤ 1250.
  linkedin: { maxChars: 3000, maxImages: 20, imageMaxPixels: 36152320, videoMinSec: 3, videoMaxSec: 30 * 60, videoMinBytes: 75 * 1024, videoMaxBytes: 500 * 1024 * 1024, documentMaxBytes: 100 * 1024 * 1024, commentMax: 1250, titleMax: 400 },
};

/**
 * X's weighted length (twitter-text v3 rules): code points in the Latin/General Punctuation ranges weigh 1,
 * everything else (CJK, emoji) 2; an emoji sequence counts once; every URL counts as 23. Text is NFC-normalized.
 */
const X_LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const X_URL = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/gi;
export function xWeightedLength(text) {
  let s = String(text || '').normalize('NFC');
  let n = 0;
  s = s.replace(X_URL, () => { n += 23; return ''; });
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment) : [...s];
  for (const g of seg) {
    if (/\p{Extended_Pictographic}/u.test(g)) { n += 2; continue; }
    for (const ch of g) {
      const cp = ch.codePointAt(0);
      if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
      n += X_LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return n;
}
/** Characters as the platform counts them, and the limit for this account. */
export function captionLength(provider, caption, account = {}) {
  if (provider === 'x') return { n: xWeightedLength(caption), max: account?.premium ? LIMITS.x.premiumChars : LIMITS.x.maxChars };
  const meta = PLATFORMS[provider];
  return { n: charCount(caption), max: meta?.maxCaption ?? Infinity };
}

export const defaultSettings = (provider) => {
  switch (provider) {
    case 'youtube':
      return { title: '', privacy: 'public', madeForKids: 'no', notifySubscribers: true, tags: [], categoryId: '22', isShort: false, thumbnail: null };
    case 'facebook':
      return { post_type: 'post', url: '', title: '', first_comment: '' };
    case 'instagram':
    case 'instagram-standalone':
      return { post_type: 'post', collaborators: [], is_trial_reel: false, graduation_strategy: 'MANUAL', share_to_feed: true, first_comment: '' };
    case 'x':
      return { thread: [], reply_settings: '' };
    case 'linkedin':
    case 'linkedin-page':
      return { post_type: 'post', visibility: 'PUBLIC', document_title: '', url: '', url_title: '', first_comment: '' };
    default:
      return {};
  }
};

export const charCount = (s) => [...String(s || '')].length;
export const youtubeTagsLength = (tags) =>
  (tags || []).reduce((t, tag) => t + String(tag).length + (/\s/.test(String(tag)) ? 2 : 0), 0);
const isUrl = (s) => /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(s || ''));
const ratioOf = (m) => (m && m.width && m.height ? m.width / m.height : null);
const mb = (b) => `${Math.round((b / 1048576) * 10) / 10} MB`;
const fmtRatio = (r) => (r ? r.toFixed(2) : '?');

/**
 * Validate one platform post.
 * @param {string} provider
 * @param {{caption:string, media:Array<{kind:string,mime:string,size:number,width?:number,height?:number,duration?:number,name?:string}>, settings:object, thumbnail?:object}} p
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validatePost(provider, { caption = '', media = [], settings = {}, thumbnail = null, thread = null, account = {} } = {}) {
  const errors = [];
  const warnings = [];
  const s = { ...defaultSettings(provider), ...(settings || {}) };
  const meta = PLATFORMS[provider];
  if (!meta) return { errors: [`Unknown platform ${provider}`], warnings };
  const { n: len, max: maxLen } = captionLength(provider, caption, account);
  if (len > maxLen) errors.push(`${meta.captionLabel} is ${len} characters; the limit is ${maxLen}${provider === 'x' && !account?.premium ? ' (X Premium accounts get 25,000)' : ''}.`);
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');
  const docs = media.filter((m) => m.kind === 'document');
  if (docs.length && !provider.startsWith('linkedin')) errors.push('Documents (PDF) can only be posted to LinkedIn.');

  if (provider === 'youtube') {
    const L = LIMITS.youtube;
    if (media.length !== 1 || videos.length !== 1) errors.push('YouTube needs exactly one video.');
    const title = String(s.title || '').trim();
    if (charCount(title) < L.titleMin) errors.push('YouTube title is required (at least 2 characters).');
    if (charCount(title) > L.titleMax) errors.push(`YouTube title is limited to ${L.titleMax} characters.`);
    if (/[<>]/.test(title) || /[<>]/.test(caption)) errors.push('YouTube does not allow "<" or ">" in the title or description.');
    if (!['public', 'unlisted', 'private'].includes(s.privacy)) errors.push('Privacy must be public, unlisted or private.');
    if (!['yes', 'no'].includes(s.madeForKids)) errors.push('Choose whether the video is made for kids.');
    if (s.categoryId && !YOUTUBE_CATEGORIES.some(([id]) => id === String(s.categoryId))) errors.push('Invalid YouTube category.');
    const tl = youtubeTagsLength(s.tags);
    if (tl > L.tagsTotal) errors.push(`YouTube tags total ${tl} characters; the limit is ${L.tagsTotal}.`);
    const v = videos[0];
    if (v && s.isShort) {
      if (v.duration && v.duration > L.shortMaxSec) errors.push(`Shorts can be at most 3 minutes (video is ${Math.round(v.duration)}s).`);
      if (v.width && v.height && v.width > v.height) errors.push('Shorts must be vertical or square (height ≥ width).');
    }
    if (v && !s.isShort && v.duration && v.duration > 15 * 60) warnings.push('Videos longer than 15 minutes require a verified YouTube channel.');
    if (thumbnail) {
      if (!['image/jpeg', 'image/png'].includes(thumbnail.mime)) errors.push('YouTube thumbnail must be JPEG or PNG.');
      if (thumbnail.size > L.thumbMaxBytes) errors.push(`YouTube thumbnail must be under 2 MB (is ${mb(thumbnail.size)}).`);
      warnings.push('Custom thumbnails require a phone-verified YouTube channel.');
    }
  }

  if (provider === 'facebook') {
    const L = LIMITS.facebook;
    const type = s.post_type || 'post';
    if (!['post', 'reel', 'story'].includes(type)) errors.push('Facebook post type must be post, reel or story.');
    if (s.url && !isUrl(s.url)) errors.push('Facebook link must be a valid http(s) URL.');
    if (type === 'post') {
      if (!media.length && !String(caption).trim() && !s.url) errors.push('Facebook post needs text, a link or media.');
      if (videos.length > 1) errors.push('Facebook posts support only one video.');
      if (videos.length && images.length) errors.push('Facebook posts cannot mix photos and a video.');
      if (images.length > L.maxPhotos) errors.push(`Facebook multi-photo posts support up to ${L.maxPhotos} photos.`);
      if (s.url && media.length) warnings.push('The link is ignored for photo/video posts; put it in the text instead.');
      if (s.title && !videos.length) warnings.push('The title is only used for video posts.');
    }
    if (type === 'reel') {
      if (media.length !== 1 || videos.length !== 1) errors.push('Facebook Reels need exactly one video.');
      const v = videos[0];
      if (v?.duration && (v.duration < L.reelMinSec || v.duration > L.reelMaxSec)) errors.push(`Facebook Reels must be ${L.reelMinSec}–${L.reelMaxSec} seconds (video is ${Math.round(v.duration)}s).`);
      if (v?.width && v?.height && v.width >= v.height) warnings.push('Facebook Reels should be vertical 9:16.');
    }
    if (type === 'story') {
      if (!media.length) errors.push('Facebook stories need at least one photo or video.');
      for (const v of videos) if (v.duration && v.duration > L.storyVideoMaxSec) errors.push(`Facebook story videos can be at most ${L.storyVideoMaxSec} seconds.`);
      if (String(caption).trim()) warnings.push('Story captions are not shown on Facebook.');
    }
    for (const i of images) {
      if (i.size > L.photoMaxBytes) errors.push(`Facebook photos should be under 4 MB (${i.name || 'image'} is ${mb(i.size)}).`);
    }
    if (s.first_comment && charCount(s.first_comment) > L.commentMax) errors.push(`First comment is limited to ${L.commentMax} characters.`);
    if (type === 'story' && s.first_comment) warnings.push('First comments are not supported on stories.');
  }

  if (provider === 'instagram' || provider === 'instagram-standalone') {
    const L = LIMITS.instagram;
    const type = s.post_type || 'post';
    const isStory = type === 'story';
    if (!['post', 'story'].includes(type)) errors.push('Instagram post type must be post or story.');
    if (!media.length) errors.push('Instagram needs at least one photo or video.');
    if (media.length > L.maxCarousel) errors.push(`Instagram carousels support up to ${L.maxCarousel} items.`);
    const carousel = !isStory && media.length > 1;
    const hashtags = (String(caption).match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
    const mentions = (String(caption).match(/(^|\s)@[\w.]+/g) || []).length;
    if (hashtags > L.maxHashtags) errors.push(`Instagram allows at most ${L.maxHashtags} hashtags (found ${hashtags}).`);
    if (mentions > L.maxMentions) errors.push(`Instagram allows at most ${L.maxMentions} @mentions (found ${mentions}).`);
    const collabs = (s.collaborators || []).filter(Boolean);
    if (collabs.length > L.maxCollaborators) errors.push(`Instagram allows at most ${L.maxCollaborators} collaborators.`);
    if (collabs.length && isStory) errors.push('Collaborators cannot be added to stories.');
    if (s.is_trial_reel) {
      if (isStory || media.length !== 1 || videos.length !== 1) errors.push('Trial Reels need exactly one video (not a story).');
      if (provider === 'instagram-standalone') warnings.push('Trial Reels may not be available for Instagram-Login accounts.');
    }
    for (const i of images) {
      if (i.mime !== 'image/jpeg') errors.push(`Instagram only accepts JPEG images (${i.name || 'image'} is ${i.mime}).`);
      if (i.size > L.imageMaxBytes) errors.push(`Instagram images must be under 8 MB (${i.name || 'image'} is ${mb(i.size)}).`);
      const r = ratioOf(i);
      if (!isStory && r && (r < L.minRatio - 0.005 || r > L.maxRatio + 0.005)) {
        errors.push(`Instagram feed images must have an aspect ratio between 4:5 and 1.91:1 (${i.name || 'image'} is ${fmtRatio(r)}).`);
      }
    }
    for (const v of videos) {
      if (!['video/mp4', 'video/quicktime'].includes(v.mime)) errors.push(`Instagram videos must be MP4 or MOV (${v.name || 'video'}).`);
      if (v.size > L.videoMaxBytes) errors.push(`Instagram videos must be under 300 MB (${v.name || 'video'} is ${mb(v.size)}).`);
      if (v.duration) {
        const max = isStory ? L.storyVideoMaxSec : carousel ? L.carouselVideoMaxSec : L.reelMaxSec;
        if (v.duration < 3) errors.push('Instagram videos must be at least 3 seconds long.');
        else if (v.duration > max) errors.push(`${isStory ? 'Story' : carousel ? 'Carousel' : 'Reel'} videos can be at most ${max >= 60 && max % 60 === 0 ? `${max / 60} minute(s)` : `${max}s`} long.`);
      }
      if (!isStory && !carousel && v.width && v.height && v.width >= v.height) warnings.push('Reels display best as vertical 9:16 video.');
    }
    if (isStory && String(caption).trim()) warnings.push('Captions are not shown on Instagram stories.');
    if (isStory && media.length > 1) warnings.push('Each item will be published as a separate story.');
    if (s.first_comment && charCount(s.first_comment) > L.commentMax) errors.push(`First comment is limited to ${L.commentMax} characters.`);
    if (isStory && s.first_comment) warnings.push('First comments are not supported on stories.');
  }
  if (provider === 'x') {
    const L = LIMITS.x;
    const xMedia = (items, where) => {
      const imgs = items.filter((m) => m.kind === 'image');
      const vids = items.filter((m) => m.kind === 'video');
      const gifs = imgs.filter((m) => m.mime === 'image/gif');
      if (vids.length > 1) errors.push(`${where}: X allows one video per post.`);
      if (vids.length && imgs.length) errors.push(`${where}: X posts cannot mix photos and a video.`);
      if (gifs.length && items.length > 1) errors.push(`${where}: an animated GIF must be the only media.`);
      if (imgs.length > L.maxImages) errors.push(`${where}: X allows up to ${L.maxImages} photos per post.`);
      for (const i of imgs) {
        const max = i.mime === 'image/gif' ? L.gifMaxBytes : L.imageMaxBytes;
        if (i.size > max) errors.push(`${where}: ${i.mime === 'image/gif' ? 'GIFs' : 'photos'} must be under ${mb(max)} on X (${i.name || 'image'} is ${mb(i.size)}).`);
      }
      const vmax = account?.premium ? L.premiumVideoMaxSec : L.videoMaxSec;
      for (const v of vids) {
        if (!['video/mp4', 'video/quicktime'].includes(v.mime)) errors.push(`${where}: X videos must be MP4 or MOV.`);
        if (v.duration && v.duration > vmax) errors.push(`${where}: video is ${Math.round(v.duration / 60)} min; X allows ${vmax / 60} min${account?.premium ? '' : ' (125 min with X Premium)'}.`);
        if (v.duration && v.duration < L.videoMinSec) errors.push(`${where}: video is too short.`);
      }
    };
    if (!String(caption).trim() && !media.length) errors.push('X posts need text or media.');
    xMedia(media, 'Post');
    const items = thread || (Array.isArray(s.thread) ? s.thread.map((t) => ({ text: t?.text || '', media: [] })) : []);
    if (items.length > L.maxThread) errors.push(`Threads are limited to ${L.maxThread} follow-up posts here.`);
    items.forEach((it, i) => {
      const n = xWeightedLength(it.text);
      if (!String(it.text || '').trim() && !(it.media || []).length) errors.push(`Thread post ${i + 2} is empty.`);
      if (n > maxLen) errors.push(`Thread post ${i + 2} is ${n} characters; the limit is ${maxLen}.`);
      xMedia(it.media || [], `Thread post ${i + 2}`);
    });
    if (s.reply_settings && !['following', 'mentionedUsers', 'subscribers', 'verified'].includes(s.reply_settings)) errors.push('reply_settings must be empty (everyone), following, mentionedUsers, subscribers or verified.');
    if (items.length) warnings.push(`Publishes as a thread of ${items.length + 1} posts (each billed as a post by X).`);
  }

  if (provider === 'linkedin' || provider === 'linkedin-page') {
    const L = LIMITS.linkedin;
    const type = s.post_type || 'post';
    if (!['post', 'document'].includes(type)) errors.push('LinkedIn post type must be post or document.');
    if (!['PUBLIC', 'CONNECTIONS'].includes(s.visibility || 'PUBLIC')) errors.push('Visibility must be PUBLIC or CONNECTIONS.');
    if (provider === 'linkedin-page' && s.visibility === 'CONNECTIONS') errors.push('Company Page posts are always public.');
    if (type === 'document') {
      if (docs.length !== 1 || media.length !== 1) errors.push('A LinkedIn document post needs exactly one PDF.');
      for (const d of docs) if (d.size > L.documentMaxBytes) errors.push(`LinkedIn documents must be under 100 MB (${d.name || 'document'} is ${mb(d.size)}).`);
      if (charCount(s.document_title) > L.titleMax) errors.push(`Document title is limited to ${L.titleMax} characters.`);
      if (!String(s.document_title || '').trim()) warnings.push('Add a document title; LinkedIn shows it above the pages.');
    } else {
      if (docs.length) errors.push('Switch the type to Document to post a PDF.');
      if (!media.length && !String(caption).trim()) errors.push('LinkedIn posts need text or media.');
      if (videos.length > 1) errors.push('LinkedIn allows one video per post.');
      if (videos.length && images.length) errors.push('LinkedIn posts cannot mix photos and a video.');
      if (images.length > L.maxImages) errors.push(`LinkedIn multi-image posts support up to ${L.maxImages} images.`);
      for (const i of images) {
        if (!['image/jpeg', 'image/png', 'image/gif'].includes(i.mime)) errors.push(`LinkedIn accepts JPG, PNG and GIF images (${i.name || 'image'} is ${i.mime}).`);
        if (i.width && i.height && i.width * i.height >= L.imageMaxPixels) errors.push(`${i.name || 'Image'} is too large for LinkedIn (max 36 megapixels).`);
      }
      for (const v of videos) {
        if (v.mime !== 'video/mp4') errors.push('LinkedIn videos must be MP4.');
        if (v.size > L.videoMaxBytes || v.size < L.videoMinBytes) errors.push(`LinkedIn videos must be 75 KB–500 MB (${v.name || 'video'} is ${mb(v.size)}).`);
        if (v.duration && (v.duration < L.videoMinSec || v.duration > L.videoMaxSec)) errors.push(`LinkedIn videos must be 3 seconds to 30 minutes (video is ${Math.round(v.duration)}s).`);
      }
      if (s.url && !isUrl(s.url)) errors.push('Link must be a valid http(s) URL.');
      if (s.url && media.length) warnings.push('The link card is only used for text posts; put the link in the text instead.');
    }
    if (s.first_comment && charCount(s.first_comment) > L.commentMax) errors.push(`First comment is limited to ${L.commentMax} characters.`);
  }
  return { errors, warnings };
}

/** Human friendly description of what will be published. */
export function describeKind(provider, media = [], settings = {}) {
  const videos = media.filter((m) => m.kind === 'video').length;
  const type = settings.post_type || 'post';
  if (provider === 'youtube') return settings.isShort ? 'Short' : 'Video';
  if (provider === 'facebook') {
    if (type === 'reel') return 'Reel';
    if (type === 'story') return media.length > 1 ? `${media.length} stories` : 'Story';
    if (videos) return 'Video post';
    if (media.length > 1) return `${media.length}-photo post`;
    if (media.length === 1) return 'Photo post';
    return settings.url ? 'Link post' : 'Text post';
  }
  if (provider === 'x') {
    const n = (settings.thread || []).length;
    const base = videos ? 'Video post' : media.length > 1 ? `${media.length}-photo post` : media.length ? 'Photo post' : 'Text post';
    return n ? `Thread of ${n + 1} (${base.toLowerCase()} first)` : base;
  }
  if (provider === 'linkedin' || provider === 'linkedin-page') {
    if (type === 'document') return 'Document (PDF) post';
    if (videos) return 'Video post';
    if (media.length > 1) return `${media.length}-image post`;
    if (media.length === 1) return 'Image post';
    return settings.url ? 'Article (link) post' : 'Text post';
  }
  if (type === 'story') return media.length > 1 ? `${media.length} stories` : 'Story';
  if (media.length > 1) return `Carousel (${media.length})`;
  return videos ? 'Reel' : 'Image post';
}
