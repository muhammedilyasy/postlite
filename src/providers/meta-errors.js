// Meta (Facebook / Instagram Graph API) error classification.
// Codes/subcodes are documented by Meta; messages are written for postlite users.

const T = 'transient', P = 'permanent', A = 'auth', D = 'disconnect';

// [needle (string or RegExp tested against the raw body), kind, message]
const IG_RULES = [
  ['An unknown error occurred', T, 'Instagram reported an unknown error; will retry.'],
  ['2207081', P, 'This account cannot publish Trial Reels.'],
  ['2207078', P, 'Trial Reel limit reached for this account; publish as a regular Reel or try later.'],
  ['2207050', P, 'This Instagram account is restricted.'],
  ['2207003', T, 'Instagram timed out downloading the media.'],
  ['2207052', T, 'Instagram could not fetch the media from your server. Check PUBLIC_URL is reachable over HTTPS.'],
  ['2207032', T, 'Instagram failed to create the media container.'],
  ['2207020', P, 'The media container expired before publishing; schedule the post again.'],
  ['2207008', P, 'The media container expired; schedule the post again.'],
  ['2207006', P, 'Instagram could not find the media; re-upload it.'],
  ['2207053', P, 'Instagram rejected the video upload (limits: 300 MB, 1920 px wide, 25 Mbps).'],
  ['2207057', P, 'Invalid video thumbnail offset.'],
  ['2207026', P, 'Unsupported video format (use MP4/MOV with H.264/AAC).'],
  ['2207023', P, 'Unknown media type.'],
  ['2207028', P, 'Instagram rejected the carousel (check item count and formats).'],
  ['2207010', P, 'Caption is too long.'],
  ['2207004', P, 'Image is too large (max 8 MB).'],
  ['2207005', P, 'Unsupported image format (Instagram accepts JPEG).'],
  ['2207009', P, 'Unsupported aspect ratio; feed images must be between 4:5 and 1.91:1.'],
  ['36003', P, 'Unsupported aspect ratio; feed images must be between 4:5 and 1.91:1.'],
  ['36001', P, 'Unsupported image resolution.'],
  ['2207042', P, 'Instagram daily publishing limit reached for this account; try again tomorrow.'],
  ['Page request limit reached', P, 'Page request limit reached for today; try again tomorrow.'],
  ['2207051', P, 'Instagram blocked this request (possible spam/automation flag).'],
  ['2207001', P, 'Instagram flagged this content as spam; change the content and retry.'],
  ['2207082', T, 'Instagram could not process this video; will retry.'],
  ['2207085', P, 'Instagram could not process the video; check format, duration and resolution.'],
  ['2207077', P, 'Instagram could not download the video.'],
  ['2207018', P, 'A collaborator could not be tagged (check username, account is public and accepts invites).'],
  ['param collaborators is not allowed', P, 'Collaborators are not allowed for this media type.'],
  ['too little or too many attachments', P, 'Carousels need between 2 and 10 items.'],
  ['2207027', P, 'Instagram returned an unknown media error.'],
  [/session has been invalidated/i, A, 'Instagram session invalidated; reconnect the account (and pause posting for a day if this repeats).'],
  [/not an instagram business/i, D, 'This Instagram account is not a professional (business/creator) account.'],
  ['You cannot access the app till you log in to', D, 'Instagram requires you to log in on instagram.com and complete a checkpoint, then reconnect.'],
  ['Session key is malformed', D, 'Instagram requires you to log in on instagram.com and complete a checkpoint, then reconnect.'],
  ['REVOKED_ACCESS_TOKEN', A, 'Access was revoked; reconnect the account.'],
];

const FB_RULES = [
  ['Error validating access token', A, 'Facebook token is invalid or expired; reconnect the Page.'],
  ['REVOKED_ACCESS_TOKEN', A, 'Facebook access was revoked; reconnect the Page.'],
  ['Unpublished posts must be posted to a page as the page itself', A, 'postlite is not authorized to publish as this Page; reconnect it.'],
  ['must be granted before impersonating', A, 'Page permissions are missing; reconnect and allow all permissions.'],
  ['1404078', A, 'Page publishing authorization required; reconnect the Page.'],
  ['1366046', P, 'Photos must be JPG/PNG under 4 MB.'],
  ['1390008', T, 'Facebook says you are posting too fast; will retry.'],
  ['1346003', P, 'Facebook flagged the content as abusive.'],
  ['1404102', P, 'Content violates Facebook Community Standards.'],
  ['1404006', P, 'Facebook requires a security check on your account.'],
  ['2069019', P, 'Facebook rejected the file as invalid.'],
  ['1366051', P, 'These photos were already posted.'],
  ['1609008', P, 'Facebook does not allow posting facebook.com links this way.'],
  ['2061006', P, 'Invalid URL in the post.'],
  ['1349125', P, 'Invalid content format.'],
  ['1404112', P, 'Facebook temporarily limited your account for security reasons.'],
  ['Name parameter too long', P, 'Post content is too long.'],
  ['1363047', T, 'Facebook service temporarily unavailable.'],
  ['1609010', T, 'Facebook service temporarily unavailable.'],
  ['4854002', P, 'Facebook requires you to confirm your identity before publishing as this Page.'],
  ['No permission to publish the video', P, 'Facebook: no permission to publish the video.'],
  [/"error_subcode":\s*459\b/, P, 'Facebook requires a security check: log in at facebook.com, complete it, then retry.'],
  [/"error_subcode":\s*492\b/, D, 'Your Facebook user no longer has a role on this Page.'],
  ['Sorry, something went wrong', T, 'Facebook is temporarily unavailable.'],
];

function parseGraph(body) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    return j?.error || null;
  } catch {
    return null;
  }
}

function genericGraph(body, status) {
  const e = parseGraph(body);
  if (!e) return null;
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const msg = e.error_user_msg || e.message || 'Graph API error';
  if (code === 190 || code === 102 || [458, 459, 460, 463, 464, 467].includes(sub) && code === 190) {
    return { kind: 'auth', message: `Access token invalid or expired (${msg}). Reconnect the account.`, code };
  }
  if ([4, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014)) {
    return { kind: 'transient', message: `Rate limit reached (${msg}).`, code };
  }
  if (e.is_transient === true || code === 1 || code === 2) return { kind: 'transient', message: msg, code };
  if (code === 10 || (code >= 200 && code <= 299)) {
    return { kind: 'permanent', message: `Missing permission: ${msg}. Make sure you have full control of the Page/account, then reconnect and grant all permissions.`, code };
  }
  if (code === 368) return { kind: 'transient', message: `Temporarily blocked by Facebook: ${msg}`, code };
  if (status >= 500) return { kind: 'transient', message: msg, code };
  return { kind: 'permanent', message: msg, code };
}

function ruleMatch(rules, body) {
  for (const [needle, kind, message] of rules) {
    if (needle instanceof RegExp ? needle.test(body) : body.includes(needle)) return { kind, message };
  }
  return null;
}

export const classifyInstagram = (body, status) => ruleMatch(IG_RULES, String(body)) || genericGraph(body, status);
export const classifyFacebook = (body, status) => ruleMatch(FB_RULES, String(body)) || genericGraph(body, status);

/** Is this Graph error a "metric not available / deprecated / no permission" for insights? */
export function isMetricUnavailable(err) {
  const e = parseGraph(err?.body || '');
  if (!e) return err?.kind === 'permanent';
  const code = Number(e.code);
  return code === 100 || code === 10 || (code >= 200 && code <= 299) || /metric|insights|nonexisting field|not available|unsupported/i.test(e.message || '');
}
