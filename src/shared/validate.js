// Platform rules + validation. Pure ESM with no Node imports: served to the browser as-is
// (/assets/shared/validate.js) so the composer and the server apply identical rules.

export const PLATFORMS = {
  youtube: { label: 'YouTube', color: '#ff0033', maxCaption: 5000, captionLabel: 'Description' },
  facebook: { label: 'Facebook Page', color: '#1877f2', maxCaption: 63206, captionLabel: 'Message' },
  instagram: { label: 'Instagram (via Facebook)', color: '#d62976', maxCaption: 2200, captionLabel: 'Caption' },
  'instagram-standalone': { label: 'Instagram (Instagram Login)', color: '#962fbf', maxCaption: 2200, captionLabel: 'Caption' },
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
};

export const defaultSettings = (provider) => {
  switch (provider) {
    case 'youtube':
      return { title: '', privacy: 'public', madeForKids: 'no', notifySubscribers: true, tags: [], categoryId: '22', isShort: false, thumbnail: null };
    case 'facebook':
      return { post_type: 'post', url: '', title: '', first_comment: '' };
    case 'instagram':
    case 'instagram-standalone':
      return { post_type: 'post', collaborators: [], is_trial_reel: false, graduation_strategy: 'MANUAL', share_to_feed: true, first_comment: '' };
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
export function validatePost(provider, { caption = '', media = [], settings = {}, thumbnail = null } = {}) {
  const errors = [];
  const warnings = [];
  const s = { ...defaultSettings(provider), ...(settings || {}) };
  const meta = PLATFORMS[provider];
  if (!meta) return { errors: [`Unknown platform ${provider}`], warnings };
  const len = charCount(caption);
  if (len > meta.maxCaption) errors.push(`${meta.captionLabel} is ${len} characters; the limit is ${meta.maxCaption}.`);
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');

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
  if (type === 'story') return media.length > 1 ? `${media.length} stories` : 'Story';
  if (media.length > 1) return `Carousel (${media.length})`;
  return videos ? 'Reel' : 'Image post';
}
