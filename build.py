"""src/page.html + wells.js + uPlot + 예시 자료 → index.html (단일 파일)

    python build.py [--sample ref.json]
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
page = (ROOT / "src" / "page.html").read_text(encoding="utf-8")
parts = {
    "/*__UPLOT_CSS__*/": (ROOT / "uPlot.min.css").read_text(encoding="utf-8"),
    "/*__UPLOT_JS__*/": (ROOT / "uPlot.iife.min.js").read_text(encoding="utf-8"),
    "/*__WELLS_JS__*/": (ROOT / "wells.js").read_text(encoding="utf-8"),
    "/*__ZONES_JS__*/": (ROOT / "zones.js").read_text(encoding="utf-8"),
}
sample = ""
if "--sample" in sys.argv:
    ref = json.loads(Path(sys.argv[sys.argv.index("--sample") + 1]).read_text())
    names = {"QQQ": "Invesco QQQ (나스닥100)", "SOXX": "iShares Semiconductor (반도체)", "TSLA": "Tesla"}
    data = {}
    for sym, r in ref.items():
        o = r["ohlcv"]
        data[sym] = {"name": names.get(sym, sym), "dates": r["dates"],
                     **{k: [round(v, 4) for v in o[k]] for k in ("open", "high", "low", "close")},
                     "volume": [int(v) for v in o["volume"]]}
    asof = max(r["dates"][-1] for r in ref.values())
    sample = "const WELLS_SAMPLE=" + json.dumps({"asof": asof, "data": data}, ensure_ascii=False, separators=(",", ":")) + ";"
if not sample and (ROOT/"sample_line.js").exists(): sample = (ROOT/"sample_line.js").read_text(encoding="utf-8")
parts["/*__SAMPLE_JS__*/"] = sample
for k, v in parts.items():
    assert k in page, k
    page = page.replace(k, v.replace("</script>", "<\\/script>"))
SKELETON = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F3F6F8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0D1319" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="웅덩이">
{head}
</head>
<body>
{body}
</body>
</html>
"""
head_end = page.index("</style>") + len("</style>")
page = SKELETON.format(head=page[:head_end], body=page[head_end:])
out = ROOT / "index.html"
out.write_text(page, encoding="utf-8")
print(f"index.html {out.stat().st_size:,} bytes")
