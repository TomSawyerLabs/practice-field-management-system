import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import Box from '@mui/material/Box';
import type { TimelapseSegment, TimelapseTimeline } from '../../../../src/types';
import {
  clock,
  mediaToWall,
  nextSegmentAfter,
  previousSegmentBefore,
  scrubTile,
  segmentAt,
  stillForGap,
  wallToMedia,
} from '../../utils/timelapseModel';

export interface PlayerHandle {
  /** Show wall-clock `t`. `scrub` is a drag in progress: the scrub sheet's
   *  tile appears at once and the video catches up behind it. */
  seek(t: number, mode: 'scrub' | 'exact'): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  setRate(rate: number): void;
  /** Step by whole frames of film (± 2 s of field time at 60×). */
  stepFrames(n: number): void;
}

interface Props {
  segments: TimelapseSegment[];
  frames: TimelapseTimeline['frames'];
  /** Bumped on every timeline fetch: a segment still being written is
   *  reloaded under a fresh URL, so the longer file is seen. */
  generation: number;
  /** The moment on screen, during playback (every animation frame) and
   *  after seeks. */
  onTime: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** Playback ran out of film in what is loaded (the page may know of a
   *  later day to carry on into). */
  onEnd?: () => void;
}

/** One `<video>` per chunk in use, kept around so going back is instant. */
interface Entry {
  key: string;
  seg: TimelapseSegment;
  el: HTMLVideoElement;
  ready: boolean;
  /** A seek waiting for the one in flight to land (latest wins). */
  pending: number | null;
  lastUsed: number;
}

/** The scrub copy of a chunk: same frames, 960 px, every frame a keyframe.
 *  Only ever seeked, never played. */
interface Proxy {
  file: string;
  el: HTMLVideoElement;
  ready: boolean;
  pending: number | null;
  lastUsed: number;
}

const POOL_SIZE = 4;
const PROXY_POOL_SIZE = 3;
const FILM_FPS = 30;
/** After the last scrub move, swap a gap's thumbnail for the full frame. */
const STILL_SETTLE_MS = 250;

const provisional = (seg: TimelapseSegment) => !!(seg.capturing || seg.estimated);

/**
 * The film side of /timelapse: plays the segments of the one logical
 * timeline back to back, skipping the quiet gaps, and shows the archival
 * still for a gap when asked to sit in one.
 *
 * Everything here is imperative on purpose. A scrub is dozens of seeks a
 * second; routing each through React state would re-render the page per
 * pointer move. Instead each chunk has its own `<video>` (a small pool) and
 * only one seek is ever in flight per element, with the newest target queued
 * behind it.
 *
 * A drag never seeks the chunk itself. Landing on a frame there means
 * decoding up to thirty 1920×1714 frames from the last keyframe — about
 * 52 ms measured, so a drag would update at under 20 fps. It seeks the
 * chunk's scrub copy instead (960 px, every frame a keyframe, ~2.4 ms), laid
 * over the film; when the drag ends the chunk seeks once to that frame and
 * the copy is taken away, so the picture sharpens in place. Until a scrub
 * copy has loaded (or for a chunk too new to have one) the scrub sheet's
 * tile stands in.
 */
export const TimelapsePlayer = forwardRef<PlayerHandle, Props>(function TimelapsePlayer(
  { segments, frames, generation, onTime, onPlayingChange, onEnd },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const proxyHostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<HTMLImageElement>(null);
  const gapRef = useRef<HTMLDivElement>(null);

  // Latest props, for the imperative code.
  const segmentsRef = useRef(segments);
  const framesRef = useRef(frames);
  const generationRef = useRef(generation);
  const onTimeRef = useRef(onTime);
  const onPlayingRef = useRef(onPlayingChange);
  const onEndRef = useRef(onEnd);
  onTimeRef.current = onTime;
  onPlayingRef.current = onPlayingChange;
  onEndRef.current = onEnd;

  const state = useRef({
    pool: new Map<string, Entry>(),
    proxies: new Map<string, Proxy>(),
    /** Between the first scrub seek and the exact one that ends the drag. */
    dragging: false,
    /** The scrub copy a drag is showing, if any. */
    scrubbing: null as Proxy | null,
    current: null as Entry | null,
    lastT: 0,
    playing: false,
    rate: 1,
    raf: 0,
    sheets: new Map<string, HTMLImageElement>(),
    overlayFor: null as { seg: TimelapseSegment; t: number } | null,
    stillTimer: 0 as number | ReturnType<typeof setTimeout>,
  }).current;

  // ── pool ────────────────────────────────────────────────────────────

  const keyOf = (seg: TimelapseSegment) => `${seg.file}@${provisional(seg) ? `g${generationRef.current}` : 'final'}`;

  const entryFor = (seg: TimelapseSegment): Entry => {
    const key = keyOf(seg);
    let entry = state.pool.get(key);
    if (entry) {
      entry.seg = seg;
      entry.lastUsed = performance.now();
      return entry;
    }
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.disablePictureInPicture = true;
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      visibility: 'hidden',
    });
    // A still-growing chunk is fetched fresh each generation; a finished one
    // is immutable and cacheable (the server says which).
    el.src = `/api/timelapse/active/${seg.file}?v=${provisional(seg) ? `g${generationRef.current}` : 'final'}`;
    const created: Entry = { key, seg, el, ready: false, pending: null, lastUsed: performance.now() };
    el.addEventListener('loadedmetadata', () => {
      created.ready = true;
      if (created.pending !== null) {
        const p = created.pending;
        created.pending = null;
        seekEntry(created, p);
      }
    });
    el.addEventListener('seeked', () => {
      if (created.pending !== null) {
        const p = created.pending;
        created.pending = null;
        seekEntry(created, p);
      } else if (state.current === created) {
        settled(created);
      }
    });
    hostRef.current?.appendChild(el);
    state.pool.set(key, created);
    evict();
    return created;
  };

  /** Keep the pool small: drop the least recently used chunk that is
   *  neither on screen nor next up. */
  const evict = () => {
    if (state.pool.size <= POOL_SIZE) return;
    const keep = new Set<Entry>();
    if (state.current) keep.add(state.current);
    const victims = [...state.pool.values()].filter(e => !keep.has(e)).sort((a, b) => a.lastUsed - b.lastUsed);
    while (state.pool.size > POOL_SIZE && victims.length > 0) {
      const v = victims.shift()!;
      v.el.pause();
      v.el.removeAttribute('src');
      v.el.load();
      v.el.remove();
      state.pool.delete(v.key);
    }
  };

  const mediaLimit = (entry: Entry) => {
    const d = entry.el.duration;
    // A growing chunk can be shorter than its estimate says.
    return Number.isFinite(d) && d > 0 ? Math.min(entry.seg.mediaEnd, d - 0.5 / FILM_FPS) : entry.seg.mediaEnd;
  };

  const seekEntry = (entry: Entry, media: number) => {
    if (!entry.ready || entry.el.seeking) {
      entry.pending = media;
      return;
    }
    const target = Math.max(0, Math.min(media, mediaLimit(entry)));
    if (Math.abs(entry.el.currentTime - target) < 0.5 / FILM_FPS) {
      if (state.current === entry) settled(entry);
      return;
    }
    entry.el.currentTime = target;
  };

  // ── scrub copies ────────────────────────────────────────────────────

  const proxyFor = (file: string): Proxy => {
    let proxy = state.proxies.get(file);
    if (proxy) {
      proxy.lastUsed = performance.now();
      return proxy;
    }
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.disablePictureInPicture = true;
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      visibility: 'hidden',
    });
    el.src = `/api/timelapse/proxy/${file}`;
    const created: Proxy = { file, el, ready: false, pending: null, lastUsed: performance.now() };
    const next = () => {
      if (created.pending !== null) {
        const p = created.pending;
        created.pending = null;
        seekProxy(created, p);
      } else if (state.scrubbing === created) {
        // The copy has the frame: show it, and drop the stand-in tile.
        el.style.visibility = 'visible';
        hideOverlay();
      }
    };
    el.addEventListener('loadeddata', () => {
      created.ready = true;
      next();
    });
    el.addEventListener('seeked', next);
    proxyHostRef.current?.appendChild(el);
    state.proxies.set(file, created);
    const victims = [...state.proxies.values()]
      .filter(v => v !== created && v !== state.scrubbing)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (state.proxies.size > PROXY_POOL_SIZE && victims.length > 0) {
      const v = victims.shift()!;
      v.el.removeAttribute('src');
      v.el.load();
      v.el.remove();
      state.proxies.delete(v.file);
    }
    return created;
  };

  const seekProxy = (proxy: Proxy, media: number) => {
    if (!proxy.ready || proxy.el.seeking) {
      proxy.pending = media;
      return;
    }
    const d = proxy.el.duration;
    const target = Math.max(0, Number.isFinite(d) ? Math.min(media, d - 0.5 / FILM_FPS) : media);
    if (Math.abs(proxy.el.currentTime - target) < 0.25 / FILM_FPS) {
      if (state.scrubbing === proxy) {
        proxy.el.style.visibility = 'visible';
        hideOverlay();
      }
      return;
    }
    proxy.el.currentTime = target;
  };

  /** Take the scrub copies off the film. */
  const hideProxies = () => {
    state.scrubbing = null;
    for (const p of state.proxies.values()) {
      p.el.style.visibility = 'hidden';
      p.pending = null;
    }
  };

  /** The video has the frame: take the scrub copy and the tile away. */
  const settled = (entry: Entry) => {
    const el = entry.el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const hide = () => {
      if (state.current === entry && entry.pending === null && !entry.el.seeking) {
        hideOverlay();
        // A drag still in progress keeps its copy up; this was an older seek.
        if (!state.dragging) hideProxies();
      }
    };
    // Wait for the frame to be composited, where the browser can say so.
    if (el.requestVideoFrameCallback && !el.paused) el.requestVideoFrameCallback(hide);
    else requestAnimationFrame(hide);
  };

  const showOnly = (entry: Entry | null) => {
    for (const e of state.pool.values()) e.el.style.visibility = e === entry ? 'visible' : 'hidden';
    if (stillRef.current) stillRef.current.style.display = entry ? 'none' : 'block';
    if (gapRef.current) gapRef.current.style.display = entry ? 'none' : 'flex';
  };

  // ── scrub overlay ───────────────────────────────────────────────────

  const sheet = (file: string): HTMLImageElement => {
    let img = state.sheets.get(file);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = `/api/timelapse/scrub/${file}`;
      img.onload = () => {
        // Repaint if this sheet is what the overlay is waiting on.
        const want = state.overlayFor;
        if (want && want.seg.scrub?.file === file) drawOverlay(want.seg, want.t);
      };
      state.sheets.set(file, img);
    }
    return img;
  };

  const drawOverlay = (seg: TimelapseSegment, t: number): boolean => {
    const canvas = overlayRef.current;
    const tile = scrubTile(seg, t);
    if (!canvas || !tile) return false;
    state.overlayFor = { seg, t };
    const img = sheet(tile.scrub.file);
    if (!img.complete || img.naturalWidth === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { tileWidth: tw, tileHeight: th } = tile.scrub;
    const scale = Math.min(w / tw, h / th);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, tile.sx, tile.sy, tw, th, (w - tw * scale) / 2, (h - th * scale) / 2, tw * scale, th * scale);
    canvas.style.visibility = 'visible';
    return true;
  };

  const hideOverlay = () => {
    state.overlayFor = null;
    if (overlayRef.current) overlayRef.current.style.visibility = 'hidden';
  };

  // ── gaps ────────────────────────────────────────────────────────────

  const showGap = (t: number, mode: 'scrub' | 'exact') => {
    const segs = segmentsRef.current;
    const still = stillForGap(framesRef.current, segs, t);
    const img = stillRef.current;
    if (img) {
      if (still) {
        // The thumbnail while dragging (40 kB); the full frame once settled.
        const thumb = `/api/timelapse/frame/${still.thumb ?? still.file}`;
        const full = `/api/timelapse/frame/${still.file}`;
        if (!img.src.endsWith(thumb) && !img.src.endsWith(full)) img.src = thumb;
        clearTimeout(state.stillTimer);
        if (mode === 'exact') img.src = full;
        else state.stillTimer = setTimeout(() => (img.src = full), STILL_SETTLE_MS);
        img.style.visibility = 'visible';
      } else {
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
      }
    }
    const gap = gapRef.current;
    if (gap) {
      const prev = previousSegmentBefore(segs, t);
      const next = nextSegmentAfter(segs, t);
      const from = prev >= 0 ? clock(segs[prev].end) : 'the start of the day';
      const to = next >= 0 ? clock(segs[next].start) : 'the end of the day';
      // Only "no video": a gap is usually the field going quiet, but it can
      // also be a match whose recording did not make it, or capture being off.
      gap.textContent =
        `No timelapse video from ${from} to ${to}` +
        (still ? ` — showing the ${clock(still.at)} archival frame` : '') +
        (next >= 0 ? '. Play to skip ahead.' : '.');
      gap.dataset.still = still ? '1' : '0';
    }
    hideOverlay();
    hideProxies();
  };

  // ── transport ───────────────────────────────────────────────────────

  const seek = (t: number, mode: 'scrub' | 'exact') => {
    state.lastT = t;
    const segs = segmentsRef.current;
    const i = segmentAt(segs, t);
    if (i < 0) {
      if (state.playing) state.current?.el.pause();
      state.current = null;
      showOnly(null);
      showGap(t, mode);
      onTimeRef.current(t);
      return;
    }
    const seg = segs[i];
    const entry = entryFor(seg);
    if (state.current !== entry) {
      if (state.current) state.current.el.pause();
      state.current = entry;
      if (state.playing) {
        entry.el.playbackRate = state.rate;
        void entry.el.play().catch(() => {});
      }
    }
    showOnly(entry);
    const media = wallToMedia(seg, t);
    state.dragging = mode === 'scrub';
    if (mode === 'scrub' && seg.proxy) {
      // Drag on the scrub copy; the chunk itself is not touched until the
      // drag ends. Media time is the same in both — same frames, same rate.
      const proxy = proxyFor(seg.proxy);
      if (state.scrubbing && state.scrubbing !== proxy) state.scrubbing.el.style.visibility = 'hidden';
      state.scrubbing = proxy;
      // Not loaded yet: the sheet's tile stands in until it is.
      if (!proxy.ready || proxy.el.style.visibility !== 'visible') drawOverlay(seg, t);
      seekProxy(proxy, media);
      onTimeRef.current(t);
      return;
    }
    // No scrub copy (a chunk too new to have one), or the drag is over: the
    // tile first — it is already decoded — then the real frame. A scrub copy
    // still on screen stays until the chunk has landed on the same frame.
    if (mode === 'scrub' || !entry.ready) drawOverlay(seg, t);
    seekEntry(entry, media);
    onTimeRef.current(t);
  };

  const preloadNext = (index: number) => {
    const next = segmentsRef.current[index + 1];
    if (!next) return;
    const entry = entryFor(next);
    if (entry.ready) {
      if (Math.abs(entry.el.currentTime - next.mediaStart) > 0.5 / FILM_FPS) entry.el.currentTime = next.mediaStart;
    } else {
      entry.pending = next.mediaStart;
    }
  };

  const loop = () => {
    if (!state.playing) return;
    const entry = state.current;
    if (entry) {
      const segs = segmentsRef.current;
      const i = segs.findIndex(s => keyOf(s) === entry.key);
      const seg = i >= 0 ? segs[i] : entry.seg;
      const media = entry.el.currentTime;
      const t = mediaToWall(seg, media);
      state.lastT = t;
      onTimeRef.current(t);
      if (seg.mediaEnd - media < 3 * state.rate) preloadNext(i);
      const atEnd = media >= mediaLimit(entry) - 0.5 / FILM_FPS || entry.el.ended;
      if (atEnd) {
        const next = i >= 0 ? segs[i + 1] : undefined;
        if (!next || (seg.capturing && entry.el.ended)) {
          // The end of the film that is loaded, or the live edge of the
          // chunk being written right now.
          pause();
          if (!seg.capturing) onEndRef.current?.();
          return;
        }
        seek(next.start, 'exact');
      }
    }
    state.raf = requestAnimationFrame(loop);
  };

  const play = () => {
    if (state.playing) return;
    const segs = segmentsRef.current;
    if (segmentAt(segs, state.lastT) < 0) {
      // In a gap: the film carries on from the next piece.
      const n = nextSegmentAfter(segs, state.lastT);
      if (n < 0) {
        onEndRef.current?.();
        return;
      }
      seek(segs[n].start, 'exact');
    }
    const entry = state.current;
    if (!entry) return;
    state.playing = true;
    state.dragging = false;
    hideProxies();
    entry.el.playbackRate = state.rate;
    void entry.el.play().catch(() => {
      // Autoplay refused, or the element was swapped out: stop cleanly.
      pause();
    });
    hideOverlay();
    onPlayingRef.current(true);
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(loop);
  };

  const pause = () => {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    state.current?.el.pause();
    onPlayingRef.current(false);
  };

  useImperativeHandle(ref, () => ({
    seek,
    play,
    pause,
    isPlaying: () => state.playing,
    setRate: (rate: number) => {
      state.rate = rate;
      if (state.current) state.current.el.playbackRate = rate;
    },
    stepFrames: (n: number) => {
      pause();
      const segs = segmentsRef.current;
      const i = segmentAt(segs, state.lastT);
      if (i < 0) {
        const j = n > 0 ? nextSegmentAfter(segs, state.lastT) : previousSegmentBefore(segs, state.lastT);
        if (j >= 0) seek(n > 0 ? segs[j].start : segs[j].end - 1, 'exact');
        return;
      }
      const seg = segs[i];
      const media = (state.current?.el.currentTime ?? wallToMedia(seg, state.lastT)) + n / FILM_FPS;
      if (media < seg.mediaStart && i > 0) seek(segs[i - 1].end - 1, 'exact');
      else if (media >= seg.mediaEnd && i + 1 < segs.length) seek(segs[i + 1].start, 'exact');
      else seek(mediaToWall(seg, media), 'exact');
    },
  }));

  // New timeline data. A finished chunk keeps its element, so playback runs
  // straight through a refresh; a chunk that was still growing (or has just
  // been finalized) has a new URL, so the moment on screen is found again in
  // the new element. With nothing on screen the page re-seeks itself.
  useEffect(() => {
    segmentsRef.current = segments;
    framesRef.current = frames;
    generationRef.current = generation;
    const cur = state.current;
    if (!cur) return;
    const same = segments.find(s => keyOf(s) === cur.key);
    if (same) {
      cur.seg = same;
      return;
    }
    const wasPlaying = state.playing;
    if (wasPlaying) pause();
    seek(state.lastT, 'exact');
    if (wasPlaying) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, frames, generation]);

  // Tear the pool down with the page.
  useEffect(
    () => () => {
      cancelAnimationFrame(state.raf);
      for (const e of state.pool.values()) {
        e.el.pause();
        e.el.removeAttribute('src');
        e.el.load();
        e.el.remove();
      }
      state.pool.clear();
      for (const p of state.proxies.values()) {
        p.el.removeAttribute('src');
        p.el.load();
        p.el.remove();
      }
      state.proxies.clear();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%', bgcolor: '#000', overflow: 'hidden' }}>
      <img
        ref={stillRef}
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'none',
          filter: 'grayscale(0.35) brightness(0.8)',
        }}
      />
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div ref={proxyHostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <canvas
        ref={overlayRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', visibility: 'hidden' }}
      />
      <Box
        ref={gapRef}
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'none',
          justifyContent: 'center',
          p: 1.5,
          color: 'grey.300',
          fontSize: 14,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
        }}
      />
    </Box>
  );
});
