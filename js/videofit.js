/*
 * videofit.js — give a video's box the video's OWN aspect ratio.
 *
 * Every stage that plays an uploaded clip was a hard 16/10 box with
 * `object-fit: cover`, which crops whatever does not match. A phone clip is
 * 9/16-ish: 576x976 (0.590) inside 1.600 keeps only 0.590/1.600 = 37% of the
 * frame's height and throws the rest away, top and bottom. The subject's hands
 * and feet are exactly what falls off.
 *
 * Switching to `contain` alone is not enough, and on the overlay stages it is
 * actively wrong. The trajectory/skeleton canvas is `inset: 0` on the same box
 * and maps normalized 0..1 coordinates across the WHOLE box, so it only lines
 * up with the picture while box ratio == video ratio. Under `cover` the video
 * is cropped and the overlay is not, so the streaks already drift on any clip
 * that is not exactly 16/10 (a 16/9 clip is off by 5.6% per side); under
 * `contain` the video letterboxes and the overlay would keep drawing into the
 * bars. Sizing the BOX to the video is what makes the two agree, and it is why
 * this is not just a CSS change.
 *
 *   fitVideoBox(video, box)                    // box takes the video's ratio
 *   fitVideoBox(video, box, { min, max })      // clamped, for list thumbnails
 *
 * `contain` and a black backdrop stay on in CSS as the floor: if metadata never
 * arrives (decode error, a src swapped out mid-load) the clip is letterboxed
 * whole rather than cropped, which is the failure that loses picture silently.
 *
 * A portrait box would run off the bottom of the window at a stage's authored
 * width, so the box is also marked `.is-portrait` and the stylesheet drives it
 * from HEIGHT instead, letting the ratio pick the width.
 */
(() => {
'use strict';

// Clamp for a stage whose overlay must align: wide enough for anamorphic film
// (2.4) and tall enough for a phone held upright (0.5). Real clips sit inside
// this, so the ratio applied is the measured one, not the limit.
const STAGE_MIN = 0.5, STAGE_MAX = 2.4;

window.fitVideoBox = function fitVideoBox(video, box, opts = {}) {
  if (!video || !box) return;
  const min = opts.min != null ? opts.min : STAGE_MIN;
  const max = opts.max != null ? opts.max : STAGE_MAX;

  const apply = () => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return false;                 // metadata not in yet
    const ratio = w / h;
    box.style.aspectRatio = String(Math.min(max, Math.max(min, ratio)));
    // Keyed on the VIDEO, not on the clamped box: a clip clamped away from its
    // true ratio is still portrait, and still needs height-driven sizing.
    box.classList.toggle('is-portrait', ratio < 1);
    return true;
  };

  // readyState >= HAVE_METADATA means videoWidth/Height are already final.
  if (video.readyState >= 1 && apply()) return;
  video.addEventListener('loadedmetadata', apply, { once: true });
};
})();
