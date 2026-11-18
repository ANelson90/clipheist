"""Helpers that drive the Studio like a user and inspect results inside the browser."""
from collections import Counter

from conftest import FIXTURES


def load(page, name):
    page.set_input_files("#fileInput", str(FIXTURES / name))
    page.wait_for_function("ClipHeist.runtime.ready && ClipHeist.runtime.demuxState === 'ready'", timeout=60_000)


def set_state(page, **values):
    page.evaluate("(v) => Object.assign(ClipHeist.state, v)", values)


def choose_preset(page, preset):
    page.click(".tabs button[data-tab='format']")
    page.click(f"label.preset:has(input[value='{preset}'])")


def add_clips(page, clips):
    """clips: list of (start, end) or (start, end, transition)."""
    page.evaluate(
        """(clips) => { const R = ClipHeist.runtime;
            clips.forEach(c => { R.inPt = c[0]; R.outPt = c[1]; document.getElementById('btnAddClip').click(); });
            R.clips.forEach((c, i) => { if (clips[i][2]) c.trans = clips[i][2]; }); }""",
        [list(c) for c in clips],
    )


def set_range(page, start, end):
    page.evaluate("(r) => { ClipHeist.runtime.inPt = r[0]; ClipHeist.runtime.outPt = r[1]; }", [start, end])


RESULT_JS = """async () => {
  const r = ClipHeist.runtime.result;
  const d = await CHDemux.open(new File([r.blob], 'out', { type: r.type }));
  const v = d.video;
  const pts = v.samples.map(s => s.pts).sort((a, b) => a - b);
  const deltas = new Set();
  for (let i = 1; i < pts.length; i++) deltas.add(Math.round((pts[i] - pts[i - 1]) * 1e6));
  return { engine: r.engine, frames: v.samples.length, expected: r.expectedFrames || null, width: v.width, height: v.height,
           rate: v.fpsInfo && v.fpsInfo.rational, deltasUs: [...deltas], audio: d.audio ? d.audio.codec : null,
           audioDur: d.audio ? d.audio.duration : 0, videoDur: v.duration, size: r.blob.size,
           frameMap: r.frameMap ? Array.from(r.frameMap) : null,
           srcFps: ClipHeist.runtime.src.fps ? ClipHeist.runtime.src.fps.measured : null };
}"""


def export(page, timeout=300_000):
    """Open the export dialog, render, and return details of the finished file (parsed in-browser)."""
    page.click("#btnExport")
    page.wait_for_selector("#stepConfirm:not([hidden])")
    page.click("#btnStartRender")
    page.wait_for_selector("#stepDone:not([hidden])", timeout=timeout)
    return page.evaluate(RESULT_JS)


def wait_done(page, timeout=300_000):
    page.wait_for_selector("#stepDone:not([hidden])", timeout=timeout)
    return page.evaluate(RESULT_JS)


def frame_steps(info):
    """Histogram of how many SOURCE frames each output frame advances (from the engine's frame map)."""
    m, f = info["frameMap"], info["srcFps"]
    return Counter(round((b - a) * f) for a, b in zip(m, m[1:]))
