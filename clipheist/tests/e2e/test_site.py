"""Pages load cleanly and the PWA pieces are wired up."""


def test_landing_page_loads_without_errors(landing):
    assert "ClipHeist" in landing.title()
    landing.wait_for_selector("a[href='editor.html']")
    assert landing.locator("#features .feature").count() >= 9
    assert landing.errors == []


def test_studio_loads_with_all_panels(studio):
    for tab in ["format", "look", "fx", "text", "audio", "post"]:
        studio.click(f".tabs button[data-tab='{tab}']")
        assert studio.locator(f".tab-panel[data-panel='{tab}']").is_visible()
    assert studio.locator("#fxList .fx-row").count() == 9
    assert studio.locator("#transGrid .trans-card").count() == 11
    assert studio.locator("#btnExport").is_disabled()
    assert studio.errors == []


def test_service_worker_registers(studio):
    ok = studio.evaluate("async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; }")
    assert ok
