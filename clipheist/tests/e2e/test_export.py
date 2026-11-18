"""Frame-exact export engine: frame counts, constant frame rate, cadence, audio."""
import helpers as h


def test_5994_webm_matches_source_frame_for_frame(studio):
    h.load(studio, "cfr5994.webm")
    h.set_state(studio, fadeIn=0, fadeOut=0, outFps="match", transition="cut")
    h.choose_preset(studio, "x-720")
    h.add_clips(studio, [(1.0, 3.0), (4.0, 6.5)])
    info = h.export(studio)
    assert info["engine"] == "exact"
    assert info["rate"] == {"num": 60000, "den": 1001, "fps": 60000 / 1001}
    assert info["frames"] == info["expected"] == 270
    assert len(info["deltasUs"]) == 1, "constant frame duration"
    steps = h.frame_steps(info)
    assert set(steps) <= {1, 61}, f"every output frame advances exactly one source frame (plus the cut): {steps}"
    assert steps[61] == 1
    assert (info["width"], info["height"]) == (1280, 720)
    assert info["audio"] in ("opus", "mp4a.40.2")
    assert abs(info["audioDur"] - info["videoDur"]) < 0.08
    assert studio.errors == []


def test_mp4_with_bframes_and_aac_source(studio):
    h.load(studio, "bframes2997.mp4")
    h.set_state(studio, fadeIn=0, fadeOut=0, outFps="match", transition="cut")
    h.choose_preset(studio, "x-720")
    h.add_clips(studio, [(0.5, 3.2), (4.1, 6.5)])
    info = h.export(studio)
    assert info["rate"]["num"] == 30000 and info["rate"]["den"] == 1001
    steps = h.frame_steps(info)
    assert steps.most_common(1)[0][0] == 1 and set(steps) - {1} == {max(steps)}, steps


def test_frame_rate_conversion_5994_to_30(studio):
    h.load(studio, "cfr5994.webm")
    h.set_state(studio, fadeIn=0, fadeOut=0, outFps="30")
    h.choose_preset(studio, "x-720")
    h.set_range(studio, 0.7, 5.3)
    info = h.export(studio)
    assert info["rate"] == {"num": 30, "den": 1, "fps": 30}
    assert info["frames"] == round(4.6 * 30)
    assert set(h.frame_steps(info)) == {2}, "evenly keeps every second frame"


def test_half_speed_slow_motion_holds_frames_evenly(studio):
    h.load(studio, "bframes2997.mp4")
    h.set_state(studio, fadeIn=0, fadeOut=0, outFps="59.94")
    studio.select_option("#speedSel", "0.5")
    h.choose_preset(studio, "x-720")
    h.set_range(studio, 1.0, 3.0)
    info = h.export(studio)
    steps = h.frame_steps(info)
    assert set(steps) == {0, 1}
    assert abs(steps[0] / steps[1] - 3) < 0.15, "each source frame is shown 4 times"
