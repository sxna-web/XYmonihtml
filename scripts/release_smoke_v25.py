from html.parser import HTMLParser
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "releases/v2.5-batch1/Worker.js"
HTML = ROOT / "releases/v2.5-batch1/index.html"

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

def node_check(path, source):
    with tempfile.NamedTemporaryFile("w", suffix=".mjs" if path.endswith(".mjs") else ".js", encoding="utf-8") as f:
        f.write(source)
        f.flush()
        subprocess.run(["node", "--check", f.name], check=True)

def main():
    worker = WORKER.read_text(encoding="utf-8")
    html = HTML.read_text(encoding="utf-8")
    node_check("worker.mjs", worker)
    parser = InlineScripts()
    parser.feed(html)
    if not parser.items:
        raise SystemExit("No inline JavaScript blocks found in release HTML")
    for index, item in enumerate(parser.items, 1):
        suffix = ".mjs" if item["type"] == "module" else ".js"
        node_check(f"inline-{index}{suffix}", "".join(item["chunks"]))
    scheduled = worker.split("async scheduled(event, env, ctx)", 1)[1]
    if "if (!sources.length) return;" in scheduled.split("\n  },", 1)[0]:
        raise SystemExit("Scheduled maintenance is skipped when there are no sync sources")
    if 'if(!token)return fail("缺少 APP 授权令牌",401' not in worker:
        raise SystemExit("APP status token gate missing")
    if 'const secret=String(env.CONVERT_KEY || env.SESSION_PEPPER || "starjump-convert")' not in worker:
        raise SystemExit("Unexpected CONVERT_KEY compatibility behavior; review before release")
    print(f"PASS: Worker syntax; {len(parser.items)} inline HTML scripts; release safety assertions")

if __name__ == "__main__":
    main()
