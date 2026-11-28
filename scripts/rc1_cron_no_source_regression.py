from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKER_SOURCE = ROOT / "backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js"
WORKER_BUNDLE = ROOT / "releases/v2.5.0-rc1/Worker.js"
RELEASE_HTML = ROOT / "releases/v2.5.0-rc1/index.html"


class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "script":
            return
        attrs = dict(attrs)
        if attrs.get("src"):
            return
        kind = attrs.get("type", "").lower().strip()
        if kind not in ("", "text/javascript", "application/javascript", "module"):
            return
        self.current = {"type": kind, "chunks": []}

    def handle_data(self, data):
        if self.current is not None:
            self.current["chunks"].append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.current is not None:
            self.items.append(self.current)
            self.current = None


def scheduled_block(source: str) -> str:
    marker = "async scheduled(event, env, ctx) {"
    start = source.find(marker)
    if start < 0:
        raise AssertionError("scheduled() entrypoint missing")
    end = source.find("\n  },\n};", start)
    if end < 0:
        raise AssertionError("scheduled() method boundary missing")
    return source[start:end]


def node_check(source: str, suffix: str = ".mjs") -> None:
    with tempfile.NamedTemporaryFile("w", suffix=suffix, encoding="utf-8") as f:
        f.write(source)
        f.flush()
        subprocess.run(["node", "--check", f.name], check=True)


def main() -> None:
    source = WORKER_SOURCE.read_text(encoding="utf-8")
    bundle = WORKER_BUNDLE.read_text(encoding="utf-8")
    html = RELEASE_HTML.read_text(encoding="utf-8")
    node_check(source)
    node_check(bundle)

    block = scheduled_block(source)
    if "if (!sources.length) return;" in block:
        raise AssertionError("Cron still exits before lifecycle maintenance when no sources exist")
    maintenance = [
        "await runVipCardMaintenance(db, cronCtx)",
        "await runNodeLifecycle(db, cronCtx)",
        "await runEntitlementMaintenance(db)",
    ]
    positions = [block.find(item) for item in maintenance]
    if any(pos < 0 for pos in positions) or positions != sorted(positions):
        raise AssertionError("Cron maintenance calls missing or out of order")
    sync_guard = block.find("if (sources.length)")
    sync_call = block.find("await runSync(db, sources")
    if sync_guard < 0 or sync_call < sync_guard or positions[-1] > sync_guard:
        raise AssertionError("Only runSync may be conditional on sources.length")

    if re.search(r'^\\s*import\\b.*(?:worker-auth-adapter|authorization)\\.mjs', bundle, re.MULTILINE):
        raise AssertionError("Bundled Worker still imports a local helper module")

    parser = InlineScripts()
    parser.feed(html)
    if not parser.items:
        raise AssertionError("No inline JavaScript blocks found in release HTML")
    for item in parser.items:
        suffix = ".mjs" if item["type"] == "module" else ".js"
        node_check("".join(item["chunks"]), suffix)

    if "localStorage.getItem('sj-api') || 'https://" in html:
        raise AssertionError("Release HTML still has a hard-coded API fallback bypassing the API input")

    print("PASS: source Worker syntax")
    print("PASS: self-contained bundled Worker syntax")
    print("PASS: Cron maintenance runs without sync sources")
    print(f"PASS: {len(parser.items)} inline HTML scripts")
    print("PASS: all HTML API calls use the configured API base")


if __name__ == "__main__":
    main()
