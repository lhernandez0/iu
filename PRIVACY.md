# Privacy policy

**IU Language Buddy**

Last updated: 2026-11-11

IU Language Buddy is a local browser extension for reading video subtitles as a
marked-up dictionary. This policy describes what the extension does with data.
It is the same on Chrome, Edge, Brave and Firefox.

## The short version

- No account, no server of ours, no analytics, no telemetry and no crash
  reporting.
- The extension does not sell, rent or share personal data.
- Settings and the optional diagnostics log stay in your browser.
- Local video files are processed in the browser and never uploaded.
- The only external host is YouTube, for the caption track of the video you are
  already watching.

## What the extension processes

On a YouTube video, the extension reads the caption track and the player
metadata for the active tab. It uses that information to show the transcript,
choose the subtitle languages, mark words and let you seek. The caption content is
processed locally. It is not sent to the developer, stored on a server, or added
to a profile.

The extension keeps the recent transcript in memory while the worker is alive.
That cache is bounded to the six most recent videos and is not persisted across a
browser restart. Closing the browser clears it.

On a local video, the extension reads the selected file and its subtitle tracks
in the browser. The file is never uploaded.

The extension also stores a small theme cache in the browser's local storage so a
sidebar can paint in the right theme without a flash. It contains a theme id only.

## YouTube requests

To read captions, the extension makes a request to YouTube's caption endpoint for
the active video. The request uses the page's own session, the same way the
video's subtitle button works. The developer does not receive the request, the
response, the video URL or your YouTube account information.

There is no other external host. The dictionaries and the local coder packages
are bundled with the extension. Looking up a word makes no network request.

## Settings and diagnostics

Settings such as languages, word list, level, theme and text size are stored in
`storage.local` in your browser. They are not synced to another device or to an
account.

The optional diagnostics log is also local. It records technical events such as a
source stage, a codec name, a count, a timing or an error code. It does not record
page URLs, video titles or ids, file names, transcript text, word lookups,
cookies or tab ids. It is bounded by age, entry count and size. You can export it
as a JSONL file or clear it under Settings > Diagnostics. The extension never
uploads it automatically.

## Permissions

The extension requests only what its shipped features use:

- `storage`: local settings and the local diagnostics log.
- `sidePanel`: display the reading panel in Chrome and Edge. Firefox uses
  `sidebar_action` instead and does not request this permission.
- `scripting`: inject the local YouTube bridge into an already-open tab when the
  panel needs it.
- `webNavigation`: notice when a YouTube page navigates to a different video and
  find the frame that holds the player. It does not record browsing history.
- `contextMenus`: add **Open video files...** to the extension's own toolbar menu.
  It does not add anything to a page's right-click menu.
- `https://*.youtube.com/*`: read the caption track of the active YouTube video.

The extension does not request `tabs`, `activeTab` or `web_accessible_resources`.
It cannot read other websites.

## Third-party material

The bundled dictionaries and coder packages are listed in
[`THIRD-PARTY.md`](THIRD-PARTY.md). They are local files. The extension does not
send your data to their authors or to any third party.

## Changes

If this policy changes, the new version will replace this file and the effective
date will change. The extension does not collect data that would need a separate
notice.

## Contact

For privacy questions, open an issue at
https://github.com/lhernandez0/iu/issues or email lhernandez0@gmail.com.
