"""Preview playback: seamless clip boundaries and instant transition previews."""
import helpers as h


def _play_reel(page, clips):
    h.add_clips(page, clips)
    page.evaluate("ClipHeist.runtime.metrics = { boundaries: [], advanceAt: 0 }")
    page.evaluate("() => { window.__t0 = performance.now(); window.__end = 0; const iv = setInterval(() => { if (!ClipHeist.runtime.seq && performance.now() - window.__t0 > 500) { window.__end = performance.now(); clearInterval(iv); } }, 10); }")
    page.keyboard.press("r")
    page.wait_for_function("window.__end > 0", timeout=60_000)
    return page.evaluate("() => ({ wall: (window.__end - window.__t0) / 1000, b: ClipHeist.runtime.metrics.boundaries, swaps: ClipHeist.runtime.swaps || 0 })")


def test_clip_boundaries_swap_decoders_instead_of_seeking(studio):
    h.load(studio, "action.mp4")
    h.set_state(studio, transition="fade", transDur=0.5)
    r = _play_reel(studio, [(3.3, 5.3), (21.7, 23.7), (37.9, 39.9), (53.1, 55.1)])
    assert r["swaps"] == 3, r
    assert max(r["b"]) < 250, f"boundary → next clip's first frame (ms): {r['b']}"
    assert r["wall"] < 8.0 + 1.5, f"8 s reel played in {r['wall']:.2f} s"


def test_changing_a_transition_previews_that_cut(studio):
    h.load(studio, "pattern60.webm")
    h.add_clips(studio, [(0.5, 2.5), (3.0, 5.0)])
    studio.click(".tabs button[data-tab='fx']")
    studio.click("label.trans-card:has(input[value='zoom'])")
    studio.wait_for_function("ClipHeist.runtime.seq && !document.getElementById('video').paused && !document.getElementById('video2').paused || (ClipHeist.runtime.seq && (!document.getElementById('video').paused || !document.getElementById('video2').paused))", timeout=10_000)
    # it plays from ~1 s before the cut and pauses shortly after the transition
    studio.wait_for_function("document.getElementById('video').paused && document.getElementById('video2').paused", timeout=15_000)
    t = studio.evaluate("ClipHeist.runtime.seq ? (() => { const q = ClipHeist.runtime.seq; return q.offsets[q.i] + (ClipHeist.runtime.mediaTime - q.segs[q.i].start); })() : -1")
    assert 2.0 <= t <= 3.6, t
    assert studio.errors == []
