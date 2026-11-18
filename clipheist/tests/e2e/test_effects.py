"""Effects, transitions, vertical output and the real-time fallback engine."""
import helpers as h


def test_vertical_export_with_effects_and_transitions(studio):
    h.load(studio, "pattern60.webm")
    h.choose_preset(studio, "shorts")
    h.set_state(studio, transition="glitch", transDur=0.5, transSfx=True, fxImpact=True, fxGlow=True, fxGrain=True,
                fxShake=True, fxRgb=True, fxVhs=True, fxBwEnd=True, caption="No way", captionAnim="pop", handle="@tester")
    h.add_clips(studio, [(0.3, 1.8), (2.2, 3.4, "whip"), (4.0, 5.5, "iris")])
    info = h.export(studio)
    assert (info["width"], info["height"]) == (1080, 1920), "exports at full resolution, not preview resolution"
    assert info["frames"] == info["expected"]
    assert len(info["deltasUs"]) == 1
    assert studio.errors == []


def test_preview_renders_below_export_resolution(studio):
    h.load(studio, "pattern60.webm")
    h.choose_preset(studio, "yt-4k")
    w = studio.evaluate("document.getElementById('canvas').width")
    assert w < 3840, "preview should render at display size, not 4K"


def test_realtime_engine_fallback(studio):
    h.load(studio, "pattern60.webm")
    h.choose_preset(studio, "x-720")
    h.set_state(studio, engine="realtime", transition="fade", fxRgb=True)
    h.add_clips(studio, [(0.5, 1.8), (3.0, 4.2)])
    info = h.export(studio)
    assert info["engine"] == "realtime"
    # real-time capture depends on machine speed (CI has no GPU), so check the file, not the frame count
    assert info["frames"] > 20
    assert abs(info["videoDur"] - 2.5) < 0.5
    assert (info["width"], info["height"]) == (1280, 720)
