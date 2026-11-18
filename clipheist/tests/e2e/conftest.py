"""Shared fixtures for the ClipHeist browser tests (pytest + Playwright, Chromium)."""
import functools
import http.server
import pathlib
import socketserver
import threading

import pytest
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
ARTIFACTS = ROOT / "tests" / "e2e" / "artifacts"


class _Handler(http.server.SimpleHTTPRequestHandler):
    """Static server. POST returns 501 like a deployment without ANTHROPIC_API_KEY."""

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.send_response(501)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"not configured"}')


@pytest.fixture(scope="session")
def base_url():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(_Handler, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(args=[
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
        ])
        yield b
        b.close()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    setattr(item, "rep_" + rep.when, rep)


def _open(browser, base_url, request, path):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, permissions=["microphone"])
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and "status of 501" not in m.text and page.errors.append(m.text))
    page.goto(base_url + path)
    page.evaluate("localStorage.clear()")
    page.reload()
    return ctx, page


@pytest.fixture
def studio(browser, base_url, request):
    ctx, page = _open(browser, base_url, request, "/editor.html")
    yield page
    if getattr(request.node, "rep_call", None) and request.node.rep_call.failed:
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / f"{request.node.name}.png"))
    ctx.close()


@pytest.fixture
def landing(browser, base_url, request):
    ctx, page = _open(browser, base_url, request, "/index.html")
    yield page
    ctx.close()
