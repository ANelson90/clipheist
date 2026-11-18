"""AI Edit (analysis → edit → preview → export) and voice-over recording."""
import helpers as h


def _analyze(page):
    page.click("#btnAiEdit")
    page.click("#btnAiAnalyze")
    page.wait_for_function("ClipHeist.runtime.ai && !ClipHeist.runtime.aiBusy", timeout=120_000)


def test_ai_edit_finds_action_bursts_and_previews(studio):
    h.load(studio, "action.mp4")
    studio.set_input_files("#musicInput", str(h.FIXTURES / "beat120.mp3"))
    _analyze(studio)
    studio.click("label.ai-style:has(input[value='hype'])")
    studio.select_option("#aiTargetSel", "short30")
    studio.click("#btnAiCreate")
    studio.wait_for_selector("#aiPreviewView:not([hidden])", timeout=60_000)
    clips = studio.evaluate("ClipHeist.runtime.clips.map(c => [c.start, c.end, c.ai.peak])")
    bursts = [(10, 14), (31, 35), (48, 52)]
    for s, e, peak in clips:
        assert any(a - 1 <= peak <= b + 1 for a, b in bursts), f"peak {peak} outside the action"
    ordered = sorted(clips)
    assert all(b[0] >= a[1] - 1e-6 for a, b in zip(ordered, ordered[1:])), "no repeated footage"
    beat = 0.5  # 120 BPM
    for s, e, _ in clips:
        assert abs(((e - s) / beat) - round((e - s) / beat)) < 0.02, "clips are whole beats long"
    st = studio.evaluate("({ preset: ClipHeist.state.preset, reframe: ClipHeist.state.autoReframe, title: ClipHeist.state.title })")
    assert st["preset"] == "shorts" and st["reframe"] and st["title"]
    studio.wait_for_function("!document.getElementById('video').paused || !document.getElementById('video2').paused", timeout=10_000)
    assert studio.errors == []


def test_ai_preview_edit_and_export(studio):
    h.load(studio, "action.mp4")
    _analyze(studio)
    studio.click("#btnAiCreate")
    studio.wait_for_selector("#aiPreviewView:not([hidden])", timeout=60_000)
    n = studio.evaluate("ClipHeist.runtime.clips.length")
    studio.fill("#aipMoments li:nth-child(1) .m-cap", "TOO CLOSE")
    studio.click("#aipMoments li:last-child .m-del")
    assert studio.evaluate("ClipHeist.runtime.clips.length") == n - 1
    studio.click("#aipFormats button[data-preset='yt-1080']")
    studio.click("#aipExport")
    studio.wait_for_selector("#stepRender:not([hidden])", timeout=10_000)
    info = h.wait_done(studio)
    assert (info["width"], info["height"]) == (1920, 1080)
    assert info["frames"] == info["expected"]
    # reopening AI Edit returns to the preview; undo restores the empty reel
    studio.click("#modalClose")
    studio.click("#btnAiEdit")
    assert studio.locator("#aiPreviewView").is_visible()
    studio.click("#aipUndo")
    assert studio.evaluate("ClipHeist.runtime.clips.length") == 0
    assert studio.errors == []


def test_voice_over_record_and_mix(studio):
    h.load(studio, "pattern60.webm")
    h.set_state(studio, voAuto=False)
    h.choose_preset(studio, "x-720")
    h.set_range(studio, 0.5, 5.5)
    studio.click(".tabs button[data-tab='audio']")
    studio.click("#btnVoRecord")
    studio.wait_for_function("ClipHeist.runtime.voRec && ClipHeist.runtime.voRec.t0 > 0", timeout=10_000)
    studio.wait_for_timeout(2000)
    studio.click("#btnRecStop")
    studio.wait_for_function("ClipHeist.runtime.vo.length === 1", timeout=15_000)
    dur = studio.evaluate("ClipHeist.runtime.vo[0].buffer.duration")
    assert 1.0 < dur < 6.0
    studio.click("#btnExport")
    summary = studio.locator("#exportSummary").inner_text()
    assert "voice-over" in summary
    studio.click("#btnStartRender")
    info = h.wait_done(studio)
    assert info["audio"] is not None
    assert studio.errors == []
